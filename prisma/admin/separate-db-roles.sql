\set ON_ERROR_STOP on

-- InfraStock - separación de roles PostgreSQL v3
--
-- Ejecutar como superusuario/DBA sobre la base "infrastock".
-- Ejemplo:
--   psql -U postgres -d infrastock -f prisma/admin/separate-db-roles.sql
--
-- Precondiciones:
--   - Existe el rol LOGIN infrastock_owner.
--   - Existe el rol LOGIN infrastock_app.
--   - infrastock_shadow ya fue creada con owner infrastock_owner.
--   - La aplicación está detenida durante esta transición.
--
-- Este archivo NO crea ni cambia contraseñas.
-- Este archivo NO modifica la migración histórica de integridad ya aplicada.

BEGIN;

DO $$
DECLARE
  v_is_superuser BOOLEAN;
BEGIN
  IF current_database() <> 'infrastock' THEN
    RAISE EXCEPTION 'Este script debe ejecutarse conectado a la base infrastock. Base actual: %', current_database();
  END IF;

  SELECT rolsuper INTO v_is_superuser
  FROM pg_roles
  WHERE rolname = current_user;

  IF COALESCE(v_is_superuser, false) = false THEN
    RAISE EXCEPTION 'Este script debe ejecutarse con un rol superusuario/DBA. Usuario actual: %', current_user;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'infrastock_owner') THEN
    RAISE EXCEPTION 'No existe el rol infrastock_owner';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'infrastock_app') THEN
    RAISE EXCEPTION 'No existe el rol infrastock_app';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 1. Ownership de base y endurecimiento del rol runtime
-- ---------------------------------------------------------------------------

ALTER DATABASE infrastock OWNER TO infrastock_owner;
ALTER ROLE infrastock_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

GRANT CONNECT ON DATABASE infrastock TO infrastock_app;
REVOKE CREATE ON DATABASE infrastock FROM infrastock_app;

-- En PostgreSQL moderno, public pertenece a pg_database_owner. Al transferir la
-- base, infrastock_owner pasa a controlar efectivamente ese schema.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM infrastock_app;
GRANT USAGE ON SCHEMA public TO infrastock_app;

-- ---------------------------------------------------------------------------
-- 2. Transferencia de ownership de relaciones existentes
-- ---------------------------------------------------------------------------

-- Primero transferimos tablas/vistas. Las secuencias enlazadas mediante
-- OWNED BY a columnas NO se alteran de forma independiente: PostgreSQL exige
-- que mantengan el mismo owner que la tabla y gestiona ese vínculo al cambiar
-- el owner de la relación principal.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.oid::regclass::text AS object_name, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_roles owner_role ON owner_role.oid = c.relowner
    WHERE n.nspname = 'public'
      AND owner_role.rolname = 'infrastock_app'
      AND c.relkind IN ('r', 'p', 'v', 'm')
    ORDER BY c.relkind, c.relname
  LOOP
    CASE r.relkind
      WHEN 'r' THEN EXECUTE 'ALTER TABLE ' || r.object_name || ' OWNER TO infrastock_owner';
      WHEN 'p' THEN EXECUTE 'ALTER TABLE ' || r.object_name || ' OWNER TO infrastock_owner';
      WHEN 'v' THEN EXECUTE 'ALTER VIEW ' || r.object_name || ' OWNER TO infrastock_owner';
      WHEN 'm' THEN EXECUTE 'ALTER MATERIALIZED VIEW ' || r.object_name || ' OWNER TO infrastock_owner';
    END CASE;
  END LOOP;
END
$$;

-- Sólo las secuencias independientes (sin dependencia OWNED BY/IDENTITY con
-- una columna) se transfieren explícitamente. Esto evita el error PostgreSQL:
-- "no se puede cambiar el dueño de la secuencia ... está enlazada a la tabla".
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.oid::regclass::text AS object_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_roles owner_role ON owner_role.oid = c.relowner
    WHERE n.nspname = 'public'
      AND owner_role.rolname = 'infrastock_app'
      AND c.relkind = 'S'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass
          AND d.objid = c.oid
          AND d.refclassid = 'pg_class'::regclass
          AND d.deptype IN ('a', 'i')
      )
    ORDER BY c.relname
  LOOP
    EXECUTE 'ALTER SEQUENCE ' || r.object_name || ' OWNER TO infrastock_owner';
  END LOOP;
END
$$;

-- Enums y domains de Prisma actualmente propiedad de infrastock_app.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT format('%I.%I', n.nspname, t.typname) AS object_name
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    JOIN pg_roles owner_role ON owner_role.oid = t.typowner
    WHERE n.nspname = 'public'
      AND owner_role.rolname = 'infrastock_app'
      AND t.typtype IN ('e', 'd')
  LOOP
    EXECUTE 'ALTER TYPE ' || r.object_name || ' OWNER TO infrastock_owner';
  END LOOP;
END
$$;

-- Funciones del schema public que todavía pertenezcan al runtime.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_roles owner_role ON owner_role.oid = p.proowner
    WHERE n.nspname = 'public'
      AND owner_role.rolname = 'infrastock_app'
  LOOP
    EXECUTE 'ALTER FUNCTION ' || r.signature || ' OWNER TO infrastock_owner';
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. Privilegios runtime sobre tablas, vistas, secuencias y tipos
-- ---------------------------------------------------------------------------

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM infrastock_app;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM infrastock_app;

-- Tablas normales de la aplicación: CRUD. AuditLog y _prisma_migrations se
-- excluyen expresamente porque requieren políticas diferentes.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.oid::regclass::text AS object_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relname NOT IN ('AuditLog', '_prisma_migrations')
  LOOP
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ' || r.object_name || ' TO infrastock_app';
  END LOOP;
END
$$;

-- Vistas: sólo lectura para runtime.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.oid::regclass::text AS object_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('v', 'm')
  LOOP
    EXECUTE 'GRANT SELECT ON TABLE ' || r.object_name || ' TO infrastock_app';
  END LOOP;
END
$$;

-- Secuencias requeridas por IDs autoincrementales.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO infrastock_app;

-- Tipos Prisma usados por el runtime.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT format('%I.%I', n.nspname, t.typname) AS object_name
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typtype IN ('e', 'd')
  LOOP
    EXECUTE 'GRANT USAGE ON TYPE ' || r.object_name || ' TO infrastock_app';
  END LOOP;
END
$$;

-- Prisma Client runtime no necesita acceso a la tabla de historial de migraciones.
REVOKE ALL PRIVILEGES ON TABLE public._prisma_migrations FROM infrastock_app;

-- AuditLog: runtime append-only a nivel de privilegios.
GRANT SELECT, INSERT ON TABLE public."AuditLog" TO infrastock_app;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public."AuditLog" FROM infrastock_app;

-- ---------------------------------------------------------------------------
-- 4. Endurecimiento específico de funciones de integridad AuditLog
-- ---------------------------------------------------------------------------

-- El INSERT legítimo de AuditLog necesita consultar la cadena previa y llamar a
-- helpers internos. Se ejecuta con derechos de infrastock_owner y search_path fijo.
ALTER FUNCTION public.infrastock_audit_before_insert() SECURITY DEFINER;
ALTER FUNCTION public.infrastock_audit_before_insert() SET search_path = pg_catalog, public;

-- El guard también queda propiedad/ejecución del owner a través del trigger.
ALTER FUNCTION public.infrastock_audit_guard_mutation() SECURITY DEFINER;
ALTER FUNCTION public.infrastock_audit_guard_mutation() SET search_path = pg_catalog, public;

-- El verificador es la única función que la API puede invocar directamente.
-- SECURITY DEFINER permite verificar sin otorgar acceso a helpers internos.
ALTER FUNCTION public.verify_audit_log_integrity() SECURITY DEFINER;
ALTER FUNCTION public.verify_audit_log_integrity() SET search_path = pg_catalog, public;

-- Helpers hash/payload: search_path fijo. Permanecen SECURITY INVOKER; sólo el
-- owner y las funciones SECURITY DEFINER anteriores necesitan ejecutarlos.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('infrastock_audit_hash', 'infrastock_audit_payload')
  LOOP
    EXECUTE 'ALTER FUNCTION ' || r.signature || ' SECURITY INVOKER';
    EXECUTE 'ALTER FUNCTION ' || r.signature || ' SET search_path = pg_catalog, public';
  END LOOP;
END
$$;

-- Quita el EXECUTE implícito que PostgreSQL concede a PUBLIC al crear funciones,
-- y también cualquier EXECUTE directo del runtime sobre funciones internas.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS signature, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'infrastock_audit_before_insert',
        'infrastock_audit_guard_mutation',
        'infrastock_audit_hash',
        'infrastock_audit_payload',
        'verify_audit_log_integrity'
      )
  LOOP
    EXECUTE 'REVOKE EXECUTE ON FUNCTION ' || r.signature || ' FROM PUBLIC';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION ' || r.signature || ' FROM infrastock_app';
  END LOOP;
END
$$;

-- Única función de integridad expuesta directamente al runtime.
GRANT EXECUTE ON FUNCTION public.verify_audit_log_integrity() TO infrastock_app;

-- ---------------------------------------------------------------------------
-- 5. Privilegios por defecto para futuras migraciones ejecutadas por owner
-- ---------------------------------------------------------------------------

ALTER DEFAULT PRIVILEGES FOR ROLE infrastock_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO infrastock_app;

ALTER DEFAULT PRIVILEGES FOR ROLE infrastock_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO infrastock_app;

-- No dejar nuevas funciones ejecutables por PUBLIC automáticamente.
ALTER DEFAULT PRIVILEGES FOR ROLE infrastock_owner IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

COMMIT;

-- Nota de operación:
-- Si una migración futura recrea AuditLog, debe volver a aplicar explícitamente
-- su política especial SELECT+INSERT y REVOKE de UPDATE/DELETE/TRUNCATE/TRIGGER.
