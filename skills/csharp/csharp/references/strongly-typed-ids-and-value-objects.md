# Strongly-typed IDs & value objects (Vogen)

## Contents

- EF converter registration
- JSON, routing, packaging
- `[ValueObject<string>]` VOs (IpAddress, PhoneNumber)
- Validation model
- Related

> Vogen 8, net10, EF Core 10. The source generator owns equality/validation/converter boilerplate.
> Used by `yusufcirak-skills:csharp-ddd` (entity ids, domain VOs) and `yusufcirak-skills:csharp` (VO language patterns).

```csharp
[ValueObject<Guid>(conversions: Conversions.EfCoreValueConverter | Conversions.SystemTextJson)]
public readonly partial struct UserId {
    public static UserId New() => From(Guid.CreateVersion7());
    private static Validation Validate(Guid v) => v == Guid.Empty ? Validation.Invalid("empty") : Validation.Ok;
}
```

- Reference-data id (few rows, DB-owned) → `[ValueObject<int>]` + DB-generated identity: `builder.Property(x => x.Id).ValueGeneratedOnAdd();`, and NO `Validate` (value is 0 before insert). App-generated id → `[ValueObject<Guid>]` seeded with `Guid.CreateVersion7()`.

## EF converter registration

Vogen generates a nested `EfCoreValueConverter` per VO. Registering them:

- Vogen's `configurationBuilder.RegisterAllInVogenEfCoreConverters()` exists BUT requires a per-id `[EfCoreConverter<T>]` marker on a partial class (explicit listing).
- To register ALL with no per-id code, assembly-scan for the nested converter (the CONVERSION stays reflection-free — it's the generated converter; only this one-time startup registration scans):

```csharp
public static void RegisterVogenEfCoreConverters(this ModelConfigurationBuilder b, params Assembly[] asms) {
    foreach (var vo in asms.SelectMany(a => a.GetTypes())) {
        var conv = vo.GetNestedType("EfCoreValueConverter");
        if (conv is null) continue;
        var cmp = vo.GetNestedType("EfCoreValueComparer");
        var p = b.Properties(vo);
        if (cmp is null) p.HaveConversion(conv); else p.HaveConversion(conv, cmp);
    }
}
```

## JSON, routing, packaging

- **JSON:** Vogen applies `[JsonConverter]` to the struct → System.Text.Json uses it automatically, no global registration.
- **Route/query binding:** Vogen generates `IParsable` → minimal API binds the id straight from the URL.
- **Package caveat:** reference Vogen with `PrivateAssets="analyzers"`, never `"all"` (the runtime `Vogen.SharedTypes` dll must still ship). Exact reference: `setups/build-analyzers.md`.

## `[ValueObject<string>]` VOs (IpAddress, PhoneNumber)

`NormalizeInput` runs first, then `Validate` on the normalized value; use `[GeneratedRegex]` for format checks. In a persistence-agnostic domain assembly use `Conversions.SystemTextJson` ONLY — an EfCoreValueConverter would force an EF Core reference into the domain project.

```csharp
[ValueObject<string>(conversions: Conversions.SystemTextJson)]
public readonly partial struct PhoneNumber {
    private static string NormalizeInput(string i) => i is null ? "" : FormattingChars().Replace(i.Trim(), "");
    private static Validation Validate(string v) => E164().IsMatch(v) ? Validation.Ok : Validation.Invalid("not E.164");
    [GeneratedRegex(@"^\+[1-9]\d{1,14}$")] private static partial Regex E164();
    [GeneratedRegex(@"[\s\-().]")] private static partial Regex FormattingChars();
}
```

## Validation model

Vogen's `From` THROWS `ValueObjectValidationException` on invalid; `TryFrom` returns Vogen's `ValueObjectOrError<T>` — NOT a `Result<T>`. If the codebase standardizes on `Result`, adapt at the boundary.

## Related

- `yusufcirak-skills:csharp-ddd` (`../csharp-ddd/SKILL.md`) — .NET Domain-Driven Design & Architecture
- `yusufcirak-skills:csharp` (`../csharp/SKILL.md`) — C# House Style
