# State as types — polymorphic state machines (no boolean flags)

## Contents

- 1. State payload — discriminated union + capability interfaces
- 2. Transitions via pattern matching (extension members, no if-else)
- 3. Construction-time invariant guard
- 4. Entity as polymorphic state
- 5. Persistence
- 6. When to reach for this — and when not
- Related

Shared worked example for the **state-as-types** pattern. Used by `dotnet:csharp` (the language pattern) and
`dotnet:ddd` (aggregate/entity state machines). The goal is to **make illegal states unrepresentable**.

Boolean flags (`bool IsApproved`) and status enums guarded by `if`-`else` scatter invariants across
call sites and permit combinations that should never exist (`IsExecuted && !IsApproved`). Instead:

- Encode each **state as a type**. Expose an operation only on the states where it is legal.
- Model the **state payload** as a discriminated union, and the **entity** as an abstract base + sealed
  per-state subtypes whose subtype is chosen by the current state.
- Drive transitions with `Try*` methods that **pattern-match** and return a *new immutable state* —
  never `if`-`else`, never mutate.

Worked domain: a money **`Transfer`** that requires **four-eyes approval** (two distinct approvers)
before it can execute. Domain placeholder types used below — `EmployeeId`, `TransferCore`,
`TransferTimestamp` — are ordinary value objects / records from the surrounding domain.

## 1. State payload — discriminated union + capability interfaces

Capability **marker interfaces** declare *which transition a state supports*. A state that cannot be
approved simply does not implement `IApprovable`, so the transition cannot be wired to it by mistake.

```csharp
// Capability markers: which transitions a state supports.
public interface IApprovable { FourEyesApproval Approve(EmployeeId approver); }
public interface IRejectable { FourEyesApproval Reject(EmployeeId rejector); }

public abstract record FourEyesApproval;

public sealed record NotRequired : FourEyesApproval;

public sealed record PendingApproval : FourEyesApproval, IApprovable, IRejectable
{
    public FourEyesApproval Approve(EmployeeId approver) => new PartlyApproved(approver);
    public FourEyesApproval Reject(EmployeeId rejector) => new Rejected(rejector);
}

public sealed record PartlyApproved(EmployeeId Approver) : FourEyesApproval, IApprovable, IRejectable
{
    // Four-eyes: the same approver cannot self-complete. Idempotent re-approve returns self.
    public FourEyesApproval Approve(EmployeeId approver) =>
        approver == Approver ? this : new FullyApproved(Approver, approver);

    public FourEyesApproval Reject(EmployeeId rejector) => new Rejected(rejector);
}

public sealed record FullyApproved(EmployeeId Approver1, EmployeeId Approver2)
    : FourEyesApproval, IRejectable
{
    public FourEyesApproval Reject(EmployeeId rejector) => new Rejected(rejector);
}

public sealed record Rejected(EmployeeId Rejector) : FourEyesApproval;
```

`NotRequired` implements neither capability — it is a terminal "approved-by-policy" state.
`Rejected` is terminal: no capability interface, so no transition leads out of it.

## 2. Transitions via pattern matching (extension members, no if-else)

Because capabilities are interfaces, the transition dispatcher matches on the *capability*, not on
each concrete variant — new states that opt into a capability work without editing the switch.

```csharp
public static class FourEyesApprovalTransitions
{
    extension(FourEyesApproval approval)
    {
        // Drives the transition only if the current state supports it; otherwise a no-op (returns self).
        public FourEyesApproval TryApprove(EmployeeId approver) => approval switch
        {
            IApprovable approvable => approvable.Approve(approver),
            _ => approval,
        };

        public FourEyesApproval TryReject(EmployeeId rejector) => approval switch
        {
            IRejectable rejectable => rejectable.Reject(rejector),
            _ => approval,
        };
    }
}
```

`Try*` never throws for an expected outcome and never mutates — it returns the resulting state. A
caller in a state that cannot approve gets the same state back, not an exception.

## 3. Construction-time invariant guard

`Assert<T1, T2>()` returns the approval when it is one of the allowed variants, else throws. It
encodes "this entity subtype may **only** wrap these states" at the constructor — so an
`ApprovedTransfer` can never be built holding a `PendingApproval`. The throw is a programmer-error
guard for a genuinely-impossible state, not an expected-flow path.

```csharp
public static class FourEyesApprovalGuards
{
    extension(FourEyesApproval approval)
    {
        public FourEyesApproval Assert<T1, T2>()
            where T1 : FourEyesApproval
            where T2 : FourEyesApproval
            => approval is T1 or T2
                ? approval
                : throw new InvalidOperationException(
                    $"{approval.GetType().Name} is not a valid state here; expected {typeof(T1).Name} or {typeof(T2).Name}.");
    }
}
```

## 4. Entity as polymorphic state

The entity is an abstract base + sealed per-state subtypes. Each subtype exposes **only** the
operations valid in that state. `Execute` lives only on `ApprovedTransfer`; a caller holding a
`PendingTransfer` cannot even call it — no defensive `if (!IsApproved) throw` anywhere.

`WithApproval` is the single dispatcher that maps an approval state to the correct entity subtype, so
each transition method is a one-liner: `TryApprove` the payload, then re-wrap.

```csharp
public abstract class Transfer
{
    protected Transfer(Guid id, TransferCore core, FourEyesApproval approval)
        => (Id, Core, Approval) = (id, core, approval);

    public Guid Id { get; }
    public TransferCore Core { get; }
    public FourEyesApproval Approval { get; }

    // Single dispatcher: approval state → the correct Transfer subtype.
    protected Transfer WithApproval(FourEyesApproval approval) => approval switch
    {
        NotRequired                       => new ApprovedTransfer(Id, Core, approval),
        PendingApproval or PartlyApproved => new PendingTransfer(Id, Core, approval),
        FullyApproved                     => new ApprovedTransfer(Id, Core, approval),
        Rejected                          => new RejectedTransfer(Id, Core, (Rejected)approval),
        _ => throw new InvalidOperationException("Unhandled approval state."),
    };
}

public sealed class PendingTransfer : Transfer
{
    public PendingTransfer(Guid id, TransferCore core) : this(id, core, new PendingApproval()) { }

    public PendingTransfer(Guid id, TransferCore core, FourEyesApproval approval)
        : base(id, core, approval.Assert<PendingApproval, PartlyApproved>()) { }

    public Transfer Approve(EmployeeId employeeId) => WithApproval(Approval.TryApprove(employeeId));
    public Transfer RejectedBy(EmployeeId employeeId) => WithApproval(Approval.TryReject(employeeId));
}

public sealed class ApprovedTransfer : Transfer
{
    public ApprovedTransfer(Guid id, TransferCore core, FourEyesApproval approval)
        : base(id, core, approval.Assert<NotRequired, FullyApproved>()) { }

    public Transfer RejectedBy(EmployeeId employeeId) => WithApproval(Approval.TryReject(employeeId));

    // Exists ONLY on the approved state — illegal to call on any other subtype, enforced at compile time.
    public ExecutedTransfer Execute(TransferTimestamp at) => new(Id, Core, Approval, at);
}

public sealed class RejectedTransfer : Transfer
{
    public RejectedTransfer(Guid id, TransferCore core, Rejected rejection) : base(id, core, rejection) { }
}

public sealed class ExecutedTransfer : Transfer
{
    public ExecutedTransfer(Guid id, TransferCore core, FourEyesApproval approval, TransferTimestamp at)
        : base(id, core, approval) => At = at;

    public TransferTimestamp At { get; }
}

public sealed class ExpiredTransfer : Transfer
{
    public ExpiredTransfer(Guid id, TransferCore core, FourEyesApproval approval) : base(id, core, approval) { }
}
```

Why this beats flags: the type you hold tells you what you can do. `pendingTransfer.Execute(...)`
does not compile. There is no reachable code path that executes an unapproved transfer.

## 5. Persistence

Persistence must not force the rich domain back into flags. Two approaches, by store type.

### 5a. Relational — pick the shape, then make ONE call

Persistence must not force the rich domain back into flags, and the caller must not branch on the state
subtype either. Choose the stored shape from the domain and the DB technology, then expose **one**
method (`transfer.WriteTo(snapshot)`); each state writes what it owns and **no-ops** for what it does
not.

| Domain / DB situation | Stored shape |
|---|---|
| DB owned by this service, few stable variants, EF tracks and mutates one instance | EF **TPH** (single table + discriminator) on a mutable `class` hierarchy |
| Transitions return new immutable instances, legacy/flag schema, or schema owned elsewhere | **Flat persistence model** (`class` when EF tracks it; `record` for Dapper / read models / snapshots) written through a domain-owned writer port (below) |
| Variants differ a lot in payload, document or JSON-capable store | one JSON column / document (5b) |

The flat-model route, with no `switch` at the call site:

```csharp
// Domain-owned port: the shape the domain agrees to be flattened into. Infrastructure implements it.
public interface ITransferSnapshot
{
    Guid Id { set; }
    TransferStatus Status { set; }
    string? Approver1 { set; }
    string? Approver2 { set; }
    string? Rejector { set; }
    DateTimeOffset? ExecutedAt { set; }
}
public enum TransferStatus { Pending, Approved, Rejected, Executed, Expired }

public abstract class Transfer
{
    // THE single entry point. Same call for every subtype.
    public void WriteTo(ITransferSnapshot snapshot)
    {
        snapshot.Id = Id;
        snapshot.Status = Status;
        Approval.WriteTo(snapshot);   // payload variants write their own columns
        WriteState(snapshot);         // subtype-specific extras
        // + flattened TransferCore columns
    }

    protected abstract TransferStatus Status { get; }
    protected virtual void WriteState(ITransferSnapshot snapshot) { }   // default: no-op
}

public sealed class PendingTransfer : Transfer { protected override TransferStatus Status => TransferStatus.Pending; /* ... */ }
public sealed class ExecutedTransfer : Transfer
{
    protected override TransferStatus Status => TransferStatus.Executed;
    protected override void WriteState(ITransferSnapshot s) => s.ExecutedAt = At;
}

// Payload DU: a virtual WriteTo with a no-op default; only variants that carry data override it.
public abstract record FourEyesApproval { public virtual void WriteTo(ITransferSnapshot s) { } }
public sealed record PartlyApproved(EmployeeId Approver) : FourEyesApproval, IApprovable, IRejectable
{
    public override void WriteTo(ITransferSnapshot s) => s.Approver1 = Approver;
    /* Approve / Reject as in section 1 */
}
public sealed record Rejected(EmployeeId Rejector) : FourEyesApproval
{
    public override void WriteTo(ITransferSnapshot s) => s.Rejector = Rejector;
}
```

The infrastructure row (`TransferRecord`) implements `ITransferSnapshot`; the repository's whole write
path is `transfer.WriteTo(record)` plus a save. Reading is the one place a discriminator switch is
unavoidable: keep it in a single `ToDomain()` and give each subtype a `Rehydrate` factory that rebuilds
it **without raising events**:

```csharp
public static Transfer ToDomain(this TransferRecord r) => r.Status switch
{
    TransferStatus.Pending  => PendingTransfer.Rehydrate(r.Id, r.Core(), r.Approval()),
    TransferStatus.Executed => ExecutedTransfer.Rehydrate(r.Id, r.Core(), r.Approval(), r.ExecutedAt!.Value),
    /* ... */
    _ => throw new InvalidOperationException("Unhandled transfer status."),
};
```

Mirror the legal state/column combinations in a DB `CHECK` constraint so the store rejects what the
types already forbid. Domain events raised by the transition are not the caller's job to persist; see
`dotnet:ddd` -> Domain-event dispatch.

### 5b. Document store — store the polymorphic JSON directly

Mongo / Elasticsearch / Cosmos: serialize the union (and the entity hierarchy) with a `$type`
discriminator and read it back polymorphically — no flat mapping needed.

```csharp
[JsonPolymorphic(TypeDiscriminatorPropertyName = "$type")]
[JsonDerivedType(typeof(NotRequired), "not_required")]
[JsonDerivedType(typeof(PendingApproval), "pending")]
[JsonDerivedType(typeof(PartlyApproved), "partly_approved")]
[JsonDerivedType(typeof(FullyApproved), "fully_approved")]
[JsonDerivedType(typeof(Rejected), "rejected")]
public abstract record FourEyesApproval;
```

**Contract trade-off**: the discriminator strings (`"partly_approved"`, …) become part of the stored
document contract. Keep them stable and decoupled from the C# type name — renaming a record must not
silently break already-stored documents. Pin them explicitly (as above) rather than relying on the
default type name.

## 6. When to reach for this — and when not

- **Use it** when an entity moves through a finite set of states with **state-specific operations**
  and cross-state invariants: "can't execute before approval", "can't approve twice by the same
  person", "rejected is terminal".
- **Don't over-apply** to a 2-state toggle with no behavioral difference between states — a `bool` (or
  a single nullable timestamp like `CompletedAt`) is clearer there. The pattern pays off once illegal
  combinations or state-specific operations exist.

## Related

- `dotnet:csharp` (`../csharp/SKILL.md`) — C# House Style
- `dotnet:ddd` (`../ddd/SKILL.md`) — .NET Domain-Driven Design & Architecture
