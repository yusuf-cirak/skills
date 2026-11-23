# Setup: optional libraries (ZLinq, ZString, Mapperly, Ardalis.GuardClauses)

Load when adding one of these packages or when a project does not have it yet. The ideas live in `../linq.md`, `../performance.md`, `../mapping.md` and `../composition.md`. Rule for all four: if the project already references the library, use it; if not, recommend it where it pays off and ask before adding the package.

## ZLinq (zero-allocation LINQ)

Install as a drop-in so call sites keep plain LINQ syntax, with no `.AsValueEnumerable()` chaining:

```bash
dotnet add package ZLinq
dotnet add package ZLinq.DropInGenerator
```

The generator emits extension methods that take overload priority over `System.Linq` for the selected target types. Configure it with one assembly attribute:

```csharp
// New project, most aggressive: everything (incl. IEnumerable<T>) routes through ZLinq.
// Generate into the app's default namespace, NOT global (""): with Enumerable included,
// a global drop-in makes normal System.Linq unreachable.
[assembly: ZLinq.ZLinqDropInAttribute("MyApp", ZLinq.DropInGenerateTypes.Everything)]

// Existing project: use Collection (Array | Span | Memory | List), NOT Everything.
// The Enumerable drop-in returns ValueEnumerable where existing code expects IEnumerable<T>
// (a real problem on net9+). Without Enumerable, `.AsEnumerable()` stays the System.Linq escape hatch.
[assembly: ZLinq.ZLinqDropInAttribute("MyApp", ZLinq.DropInGenerateTypes.Collection)]
```

`DropInGenerateTypes` is a flags enum (`Array`, `Span`, `Memory`, `List`, `Enumerable`) with the combos `Collection = Array | Span | Memory | List` and `Everything = Collection | Enumerable`. Where the drop-in is not configured, chain `.AsValueEnumerable()` before the operators. Packaging caveats for the generator: `build-analyzers.md`.

## ZString (zero-allocation string building)

`dotnet add package ZString`. Until it is in, fall back to `StringBuilder` or interpolation.

```csharp
using Cysharp.Text;

var line = ZString.Format("settled {0} in {1}ms", orderId, elapsedMs); // no boxing, no intermediate strings
var csv  = ZString.Join(',', ids);

using var sb = ZString.CreateStringBuilder();       // pooled buffer, always `using`
using var utf8 = ZString.CreateUtf8StringBuilder(); // writes UTF8 directly, pairs with IBufferWriter<byte>
```

## Mapperly (source-generated object mapping)

`riok/Mapperly`: source-generated, free, zero-alloc, compile-time checked. Never add a reflection-based mapper to a project that does not already have one.

```csharp
[Mapper]
public partial class ActivityMapper
{
    public partial ActivityResponse ToResponse(Activity activity); // generated at build time
}
```

## Ardalis.GuardClauses

The de-facto guard vocabulary for programmer-error preconditions. Recommend it only when guards are scattered and inconsistent and no convention exists. Otherwise match the codebase's own guard style.

```csharp
Guard.Against.Null(input);
Guard.Against.NullOrWhiteSpace(name);
Guard.Against.NegativeOrZero(qty);
Guard.Against.OutOfRange(page, nameof(page), 1, InputLimits.MaxPageSize);

// project-specific guard as an extension, so the call site stays Guard.Against.*
public static class GuardExtensions
{
    public static string InvalidEmail(this IGuardClause guard, string input,
        [CallerArgumentExpression(nameof(input))] string? name = null)
        => EmailRegex.IsMatch(input) ? input : throw new ArgumentException("invalid email", name);
}
```
