---
match: ["**/models.py", "**/serializers.py", "**/views.py", "**/urls.py", "**/migrations/*.py", "**/settings*.py", "**/tasks.py", "**/admin.py", "**/permissions.py"]
---
# Django

- Trace request querysets through tenant and object authorization. Check that lookups are scoped to the requesting principal and object permissions run on the actual object.
- Look for relation access in loops or serializers that creates N+1 queries, unbounded list endpoints, and repeated queryset evaluation.
- Check whether bulk `update()` or `delete()` bypasses model hooks or signals relied on elsewhere.
- For schema changes, verify matching migrations, safe defaults for existing rows, dependency order, reversible data operations, and deployment compatibility.
- Review field nullability, uniqueness assumptions, deletion behavior, timezone handling, and decimal precision against call sites.
- Keep validation in the established boundary, make multi-row writes atomic where partial completion is invalid, and defer external work until commit when needed.
- Check exposed serializer fields, permission defaults, production settings, and new environment requirements.
