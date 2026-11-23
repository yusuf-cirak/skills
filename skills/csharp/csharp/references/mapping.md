# Object mapping

Prefer simple hand-written mapper methods:

```csharp
public class MyClass
{
    public MyClassDto ToDto() => new();
}
```

When mapping volume justifies a library, use a source-generated mapper such as Mapperly (free, zero-alloc, compile-time checked). Never introduce a reflection-based mapper to a project that does not already have one. Install and usage: `setups/optional-libraries.md`.
