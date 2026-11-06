# Yakumo

[![downloads](https://img.shields.io/npm/dm/yakumo?style=flat-square)](https://www.npmjs.com/package/yakumo)
[![npm](https://img.shields.io/npm/v/yakumo?style=flat-square)](https://www.npmjs.com/package/yakumo)
[![GitHub](https://img.shields.io/github/license/cordiverse/yakumo?style=flat-square)](https://github.com/cordiverse/yakumo/blob/main/LICENSE)

Manage complex workspaces with ease.

The name comes from the Japanese word "八雲". In Touhou Project, Yakumo Yukari is monster of the realm, one of the sages of Gensokyo. The summon she manages even has its own summon. Hence, the name also indicates that this library's capability of managing nested workspaces.

## Features

- **Flexibility**. Host monorepo, multirepo or even nested workspaces with same experience.
- **Powerful**. Yakumo has many features out of the box, including dependency management and more.
- **Extensible**. Allows to customize your own scripts with zero configuration.

## Repository Lockfiles

Yakumo can maintain a standalone lockfile for each nested repository while dependencies are installed once at the outer workspace root. The following package managers are supported; each writes the latest format of its lockfile:

| Package Manager | Versions | Lockfile |
| --- | --- | --- |
| Yarn | 4 | `yarn.lock` |
| npm | 9 or later | `package-lock.json` (`lockfileVersion` 3) |
| pnpm | 9 or later | `pnpm-lock.yaml` (`lockfileVersion` 9.0) |

Synchronization fails when the outer root uses a version outside this table. With Yarn Classic, `yakumo postinstall` performs no action. Add the following lifecycle script to the root `package.json`:

```json
{
  "scripts": {
    "postinstall": "yakumo postinstall"
  }
}
```

The following commands run from the outer root:

```sh
yarn yakumo lock                     # synchronize all repository lockfiles
yarn yakumo lock external/foo        # synchronize selected repositories
yarn yakumo lock --immutable         # fail if any repository lockfile is missing or outdated
```

### Workspaces

Yarn 4 expands the workspaces that nested workspaces declare. npm and pnpm read only the declaration of the outer root, so `yakumo prepare` adds the workspace patterns of each nested repository to it: the `workspaces` field of `package.json` for npm, and the `packages` field of `pnpm-workspace.yaml` for pnpm. A nested pnpm repository declares its workspaces in its own `pnpm-workspace.yaml`. A pattern is added unless the outer root already contains it or excludes it with `!`. The outer root applies an exclusion to all of its patterns, so an exclusion of a nested repository is added only if the directories it excludes are neither existing workspaces nor included by a pattern that another repository adds; otherwise `prepare` reports it as skipped. Before merging, `prepare` rewrites the patterns into an equivalent list without order-dependent exclusions, following the rules of the package manager, and writes the exclusions after the other patterns, where npm applies them to every pattern. `prepare --clean` removes the patterns inside nested workspaces that no workspace declares any longer, and keeps the exclusions of the outer root.

### Targets

By default, every nested Git repository that contains workspace packages is a target. A repository receives one lockfile covering its root and the workspaces it declares, as its package manager discovers them in a standalone checkout. Targets can also be configured as root-relative directories or globs:

```json
{
  "yakumo": {
    "lockfiles": {
      "repositories": ["external/*"]
    }
  }
}
```

### Resolution

For each target, Yakumo copies the manifests and the package manager configuration of the repository into a temporary directory, seeds a lockfile from the root lockfile and the previous repository lockfile, and updates it there without installing packages:

| Package Manager | Configuration | Command |
| --- | --- | --- |
| Yarn | `.yarnrc.yml` | `yarn install --mode=update-lockfile` |
| npm | `.npmrc` | `npm install --package-lock-only` |
| pnpm | `pnpm-workspace.yaml`, `.npmrc` | `pnpm install --lockfile-only` |

The root lockfile takes precedence over the previous repository lockfile. For Yarn, the seed contains the registry records of both. For npm, the seed keeps the hoisted registry packages of the root and moves the packages installed below the repository to the corresponding locations. For pnpm, the seed maps the importers of the repository projects from the root lockfile. A dependency that the root links to a workspace of another repository is taken from the previous repository lockfile. Packages that the repository does not use are removed from the result.

A repository that pins another version of the same package manager through `packageManager` or `devEngines.packageManager` is resolved with that version through Corepack. Workspace manifests that are ignored by Git are excluded.

Lockfiles are written only after every target has been resolved. The root lockfile and the manifests are never modified.

A repository is skipped with a warning when it uses a configuration that cannot be exported:

- dependencies other than registry ranges, tags, npm aliases, internal `workspace:` references and, for pnpm, `catalog:` references;
- workspaces outside the repository;
- another package manager than the outer root, or a version that does not write the latest lockfile format;
- for Yarn, custom plugins, releases, environment files or patches;
- for npm, `npm-shrinkwrap.json`;
- for pnpm, pnpmfiles, patches, or lockfiles other than a single shared `pnpm-lock.yaml`.

`--strict` or `yakumo.lockfiles.strict` turns these warnings into errors.

### Immutable Mode

`lock --immutable` resolves lockfiles without writing them. `lock` and `postinstall` also run in this mode when `CI` is set to a value other than empty, `0` or `false`.

Yarn caches lifecycle scripts, so `postinstall` does not run after every installation, and `--mode=skip-build` skips it. npm and pnpm skip it with `--ignore-scripts`. CI should therefore run an explicit check:

```sh
yarn install --immutable
yarn yakumo lock --immutable
```

### Limitations

A nested lockfile makes its repository a separate project. Commands that run in such a repository look for an installation inside the repository. For Yarn, this includes `yarn workspace <name> <script>` issued from the outer root, which fails.

pnpm 11 and later warn on every installation from the outer root that the `pnpm-workspace.yaml` of a nested repository does not apply.

## Official Extensions

| Extension | Version | Description |
| ------ | ------ | ----------- |
| [yakumo-esbuild](./packages/esbuild/) | [![npm](https://img.shields.io/npm/v/yakumo-esbuild?style=flat-square)](https://www.npmjs.com/package/yakumo-esbuild) | execute [esbuild](https://esbuild.github.io) |
| [yakumo-mocha](./packages/mocha/) | [![npm](https://img.shields.io/npm/v/yakumo-mocha?style=flat-square)](https://www.npmjs.com/package/yakumo-mocha) | execute [mocha](https://mochajs.org) |
| [yakumo-tsc](./packages/tsc/) | [![npm](https://img.shields.io/npm/v/yakumo-tsc?style=flat-square)](https://www.npmjs.com/package/yakumo-tsc) | compile [TypeScript](https://www.typescriptlang.org) |
