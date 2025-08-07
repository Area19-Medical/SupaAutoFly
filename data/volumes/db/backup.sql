CREATE SCHEMA IF NOT EXISTS backup;

DROP FUNCTION IF EXISTS backup.make_base_backup();
CREATE FUNCTION backup.make_base_backup()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  RAISE WARNING 'Starting base backup...';
  CREATE TEMPORARY TABLE backup_output(
    output text
  );

  BEGIN
    COPY backup_output FROM PROGRAM 'make-base-backup.sh' DELIMITER E'\u001C';
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Base backup failed: %', SQLERRM;
    RETURN;
  END;

  RAISE WARNING 'Base backup completed.';
END;
$$;
