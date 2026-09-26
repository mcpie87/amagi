---
match: ["**/migrations/**", "**/*.sql", "**/schema.prisma", "**/liquibase/**", "**/changelog/**"]
---
# SQL and migrations

- Check migration ordering, rollback behavior, repeated application, and whether old and new application versions can coexist during deployment.
- For added required columns, verify existing rows receive valid values without unsafe table-wide rewrites or lock duration.
- Review index and constraint creation for table size, database engine behavior, and write availability.
- Check data migrations use the schema version available at that point, preserve data, and have a credible reverse or recovery path.
- Verify queries use the intended keys and constraints, parameterize values, and do not change null, uniqueness, or cascade semantics unexpectedly.
- Check renames and drops against all readers, writers, background jobs, and deployed clients that can still use the old shape.
