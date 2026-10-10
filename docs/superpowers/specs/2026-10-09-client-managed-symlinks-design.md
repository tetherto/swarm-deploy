# Client-Managed Symlinks Design

## Status and scope

This design extends v0.2.0's automatic managed symlinks with authenticated,
client-selected links. Automatic reconciliation remains unchanged. The new
operation authorizes the client to select an existing managed artifact as a
target; it does not let the client upload through, replace, or delete arbitrary
top-level paths.

## Operator policy

The repeatable server syntax is:

```text
--symlink <selector> [<link-name>]
```

The corresponding `ServerOptions.symlinks` entries have exactly one of these
shapes:

```ts
{ selector: string, name: string } // automatic reconciliation
{ selector: string }               // manual target authorization
```

A selector is either an exact safe managed artifact basename or an unflagged
`/regex/`. Repeated one-argument rules form a target allowlist: exact rules
authorize individual files or directories, while regular-expression rules
authorize sets of managed artifact basenames.

Automatic rule names are unique. They are the only values returned by
`symlinkRuleNames`, and only automatic rules participate in
`selectDesiredLinks`. Manual authorization rules never create or reconcile a
link by themselves.

Configuration fails closed for invalid iterables or object shapes, duplicate
automatic names, duplicate manual rules, malformed or oversized selectors,
unsafe exact selectors, reserved history names, unsafe or reserved automatic
names, and an exact automatic selector equal to its own link name. A manual
target match also fails closed for an unsafe or reserved target basename.

## Client operation

The client syntax is:

```text
swarm-deploy link <target> <link-name>
```

It accepts the existing client identity and server-key options. The direct
HyperDHT connection and configured server allowlist authenticate the caller in
the same way as uploads.

`target` must name an existing managed top-level file or directory and must
match at least one manual authorization rule. `link-name` may be any safe
top-level link name except:

- reserved names;
- a self-link equal to `target`;
- an automatic link name;
- a managed artifact name; or
- a path occupied by unmanaged content.

The server checks these conditions under the storage-root lease so a concurrent
commit, retention pass, recovery action, or link operation cannot invalidate a
decision between inspection and mutation.

## Control-operation semantics

Link requests are explicit control RPCs, separate from the upload offer and TAR
protocol. A successful request returns exactly one of:

- `LINKED` when the server creates the link or changes its target;
- `UNCHANGED` when the same managed link already points to the requested
  target.

The operation is idempotent. Retrying an acknowledged or ambiguously
disconnected request converges on the same link and returns `UNCHANGED` once
that state is already durable. Link RPCs do not invoke artifact commit hooks.

## Ownership and persistence

Automatic and manual links have separate durable ownership modes. Automatic
records remain controlled by newest-match reconciliation. Manual records remain
at the client-selected target and are changed only by an explicit authorized
link operation.

Removing a manual authorization rule prevents future requests that depended on
that rule, but does not remove or rewrite an existing manual link. This avoids
turning a policy restart into an implicit deployment rollback.

Existing v1 link records are treated as automatic. This preserves v0.2.0
behavior across upgrade without requiring migration before startup
reconciliation.

Automatic names remain reserved from manual operations even while their rule is
dormant. Managed artifacts and unmanaged occupied paths are never replaced by a
manual link. These collision rules preserve the existing invariant that the
server mutates only paths whose managed ownership it can prove.

## Completed implementation

The completed implementation includes compiled one-argument authorization
rules, automatic-name filtering, the authenticated link control RPC, durable
manual ownership records, server dispatch and retention pinning, and the
`swarm-deploy link` CLI command. Manual rules remain excluded from automatic
selection.
