---
match: ["**/*.java", "**/*.kt", "**/*.kts", "**/pom.xml", "**/build.gradle", "**/build.gradle.kts"]
---
# Java and Kotlin

- Check nullability at Java/Kotlin and external-data boundaries, including platform types and deserialization defaults.
- Trace exceptions, coroutine cancellation, transaction rollback, and resource closure; broad catches must not turn failure into apparent success.
- Look for blocking work on async or UI dispatchers, lost coroutine jobs, and shared mutable state accessed without synchronization.
- Verify collection mutability and aliasing, equality/hash consistency, and that map or set keys remain stable.
- Check transaction boundaries around multiple writes and external effects, including retries and after-commit behavior.
- Review dependency and build configuration changes for runtime scope, version alignment, and supported targets.
