# Setup: test project and package stack

Load when creating a test project or adding a test package. The rules (naming, AAA, asserting on monads, real dependencies for integration tests) live in `yusufcirak-skills:csharp-testing`.

**Check the project first.** If it already has a test framework, assertion or mocking library, keep using it. The rules are about structure and discipline, not about forcing a library swap. On a new test project with no convention, propose the stack below and confirm before adding packages the project does not have.

| Concern | Library | Note | Common alternatives |
|---|---|---|---|
| Test framework | **xUnit** | `[Fact]` / `[Theory]` + `[InlineData]`/`[MemberData]`/`[ClassData]`. | NUnit, MSTest (same AAA and naming rules apply). |
| Assertions | **Shouldly** | `result.ShouldBe(x)`. Free, expressive failure messages. | FluentAssertions, bare `Assert.*`. |
| Mocking | **NSubstitute** | `Substitute.For<T>()`. Mock outbound ports only (HttpClient handlers, brokers), never the domain. | Moq, FakeItEasy. |
| Time | **`Microsoft.Extensions.TimeProvider.Testing`** | `FakeTimeProvider`, advanced with `Advance(...)`. | none |
| Integration infra | **Testcontainers** | Real Postgres/Redis/etc. via Docker. No in-memory provider for DB-bound tests. | none |
| DB reset | **Respawn** | Truncate between integration tests instead of recreating the container. | Hand-rolled truncate script. |
| Test data | **Bogus** | Seeded `Faker<T>` wrapped in builders or an Object Mother. Deterministic. | AutoFixture, hand-written builders. |
| Architecture | **NetArchTest** | Enforce DDD layer boundaries. | `ArchUnitNET`. |
| Coverage | **coverlet** | Collected in CI with a threshold gate. | Built-in VSTest collector. |

Layout: one test project per production project (`<Project>.UnitTests`, `<Project>.IntegrationTests`) plus one solution-wide `Architecture.Tests`.
