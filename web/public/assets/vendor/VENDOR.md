# Vendored browser modules

The page allows only same-origin scripts and has no build step, so the view layer's libraries
are copied here unchanged from their npm packages. Each file is byte-identical to the file in
the published tarball. Only the Preact file name differs, so the hub serves it as `.js`.

| File | Package | Source in tarball | sha256 |
| --- | --- | --- | --- |
| `preact.module.js` | preact 11.0.0 | `package/dist/preact.mjs` | `7f8e0de60ede059be0e5ac12c79734a90840fb8a17b8b3282724433b6c4d8c61` |
| `htm.module.js` | htm 3.1.1 | `package/dist/htm.module.js` | `ab33dd3f38059b9be4d5f5350128eefb2356639c4e0bbe9d9e8b3ba75847e9e4` |
| `preact.LICENSE` | preact 11.0.0, MIT | `package/LICENSE` | `1fe6958409c8c257a70c587a18b6f7f412b179b456630790d30b2ec9a8e4b7d4` |
| `htm.LICENSE` | htm 3.1.1, Apache-2.0 | `package/LICENSE` | `740725f7252e750af735d0028cc534970772f513331e9f68150fede8fb3ce00f` |

The tarballs matched the registry's integrity values when they were fetched on 2026-10-06:

| Tarball | npm integrity |
| --- | --- |
| `preact-11.0.0.tgz` | `sha512-LRTLKuSe6VYPhvBDjwFaX+nuZnpsw6IN2GSboisAvhGsncylBmrbDCERhgKDn6yP2mAwbGvsB5OVyTe33M8gBg==` |
| `htm-3.1.1.tgz` | `sha512-983Vyg8NwUE7JkZ6NmOqpCZ+sh1bKv2iYTlUkzlWmA5JD2acKoxd4KVxbMmxX/85mtfdnDmTFoNKcg5DGAvxNQ==` |

Preact 11 is used instead of 10.29.8 because it moves keyed nodes with `moveBefore` where the
browser has it. A moved Recent row then keeps keyboard focus and its running blink. Preact
10.29.8 moves with `insertBefore`, which drops focus to the page body and restarts the moved
row's animation. Both were measured in Chromium 149.

To check the files:

```
cd web/public/assets/vendor && sha256sum preact.module.js htm.module.js preact.LICENSE htm.LICENSE
```

To update, run `npm pack preact@<version> htm@<version>`, compare each tarball's sha512 with
`npm view <package>@<version> dist.integrity`, copy the files above, and update this table.
