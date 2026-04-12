# MFS Draft

## Context

WTB currently stores web content metadata in `src/main/web_content_sources.ts` using a repository-local manifest file. The manifest is not just a CID index. It also drives:

- source mode selection: `local`, `dual`, `ipfs-backed`
- virtual directory behavior
- directory listing and path resolution
- file replace, rename, copy, move, and delete semantics
- HTTP compatibility fallback through `web_service_manager.ts`

At the same time, large-file storage already prefers IPFS-backed content and the long-term direction is to make IPFS the default storage plane.

## What MFS Would Change

MFS would make Kubo hold the mutable directory tree for managed web content. Instead of treating the manifest as the authoritative path map, WTB would use Kubo's `files.*` APIs as the source of truth for:

- directory structure
- file placement by logical path
- rename / move / delete operations
- snapshot root export to CID or IPNS later

That would reduce the amount of custom path-to-CID bookkeeping in WTB, but only for storage topology. It would not automatically replace all of the extra metadata WTB currently maintains.

## What MFS Does Not Replace

Even with MFS, WTB still needs some application metadata outside Kubo for at least these cases:

- `sourceMode` compatibility while `local` and `dual` still exist
- MIME overrides or compatibility hints if WTB wants them independent of file sniffing
- migration state and fallback policy
- UI-only flags or future publishing metadata

So an MFS migration should be framed as "move directory truth into Kubo" instead of "delete all metadata files".

## Why Not Switch Now

The current codebase is too coupled to the manifest layer to make MFS a safe incidental change.

High-coupling areas:

- `src/main/web_content_sources.ts` reads, writes, and mutates manifest entries across import, replace, delete, rename, paste, migrate, and conversion workflows.
- `src/main/web_service_manager.ts` resolves local-vs-IPFS behavior through this content-source abstraction.
- Renderer management screens already assume the current content-source model.

Switching to MFS in one step would therefore be an architectural migration, not a storage backend swap.

## Recommended Migration Plan

### Phase 0: Do Now

- Keep the manifest-based content model.
- Move main-process IPFS writes from blocking CLI calls to `kubo-rpc-client`.
- Keep renderer out of direct Kubo API access.
- Preserve current `local / dual / ipfs-backed` semantics.

### Phase 1: Introduce an Internal Storage Adapter

- Add a small storage abstraction inside `web_content_sources.ts`.
- Separate path operations from metadata operations.
- Make the current manifest-backed implementation one adapter.
- Add an experimental MFS-backed adapter without switching the UI yet.

### Phase 2: Mirror Managed Entries Into MFS

- For `ipfs-backed` content only, create a managed MFS subtree such as `/wtb/web/<site-id>/...`.
- Keep the manifest as compatibility metadata while validating parity.
- Add integrity checks between MFS state and manifest-derived state.

### Phase 3: Flip Path Truth to MFS

- Use MFS directory listings and stat calls as the canonical source for managed content paths.
- Reduce the manifest to compatibility metadata only.
- Rework rename, delete, copy, and move to use `files.mv`, `files.rm`, `files.cp`, and `files.mkdir`.

### Phase 4: Reevaluate `dual` and `local`

- Decide whether `dual` remains a supported long-term mode.
- If `local` remains necessary, keep a thin metadata layer for mixed storage.
- If all managed content becomes IPFS-native, shrink the manifest further or replace it with a smaller metadata index.

## Risks To Watch

- MFS is node-local mutable state, so publishing still needs explicit root CID or IPNS handling.
- Garbage collection and pinning strategy must stay explicit.
- Empty directories, virtual directories, and compatibility fallback need dedicated tests.
- Any partial migration that mixes manifest truth and MFS truth without a clear precedence rule will create drift bugs.

## Current Decision

- Do not switch the web content model to MFS yet.
- Do adopt `kubo-rpc-client` in the Electron main process now.
- Revisit MFS only after the content-source layer is split into storage and metadata concerns.
