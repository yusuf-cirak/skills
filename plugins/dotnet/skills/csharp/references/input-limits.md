# InputLimits constants

## Contents

- Related

Single shared static class for all length / size / count limits. Place in `BuildingBlocks.Domain` or the project's equivalent shared layer. Validators, value objects, endpoints, and Kestrel config reference these — never inline magic numbers.

Used by `dotnet:validation` (the canonical owner) and referenced from `dotnet:hardening` (upload size, etc.).

```csharp
public static class InputLimits
{
    public const int ShortTextMaxLength = 256;
    public const int MediumTextMaxLength = 1_024;
    public const int LongTextMaxLength = 4_000;
    public const int XLongTextMaxLength = 16_000;
    public const int MaxCollectionItems = 1_000;
    public const int MaxJsonDepth = 32;
    public const long MaxRequestBodyBytes = 1 * 1024 * 1024;   // 1 MB default JSON body
    public const long MaxUploadBytes = 25 * 1024 * 1024;       // 25 MB upload
    public const int MaxPageSize = 200;
}
```

## Related

- `dotnet:validation` (`../validation/SKILL.md`) — ASP.NET Core Input Security & Serialization Limits
- `dotnet:hardening` (`../hardening/SKILL.md`) — Production Hardening (FAANG-level)
