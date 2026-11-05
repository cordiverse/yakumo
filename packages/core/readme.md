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

Yakumo can maintain a standalone `yarn.lock` for each nested repository while dependencies are installed once at the outer workspace root. This feature supports Yarn 4; with other package managers, `yakumo postinstall` performs no action. Add the following lifecycle script to the root `package.json`:

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

### Targets

By default, every nested Git repository that contains workspace packages is a target. A repository receives one lockfile covering its root and all workspaces it declares recursively. Targets can also be configured as root-relative directories or globs:

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

For each target, Yakumo copies the manifests and `.yarnrc.yml` of the repository into a temporary directory, seeds a lockfile with the registry records of the root lockfile and the previous repository lockfile, and runs `yarn install --mode=update-lockfile` there. Records in the root lockfile take precedence. A repository that pins another Yarn 4 version through `packageManager` is resolved with that version through Corepack. Workspace manifests that are ignored by Git are excluded.

Lockfiles are written only after every target has been resolved. The root lockfile and the manifests are never modified.

A repository is skipped with a warning when it uses a configuration that cannot be exported: dependencies other than registry ranges, tags, npm aliases and internal `workspace:` references; custom Yarn plugins, releases or patches; or workspaces outside the repository. `--strict` or `yakumo.lockfiles.strict` turns these warnings into errors.

### Immutable Mode

`lock --immutable` resolves lockfiles without writing them. `lock` and `postinstall` also run in this mode when `CI` is set to a value other than empty, `0` or `false`.

Yarn caches lifecycle scripts, so `postinstall` does not run after every installation, and `--mode=skip-build` skips it. CI should therefore run an explicit check:

```sh
yarn install --immutable
yarn yakumo lock --immutable
```

### Limitations

A nested `yarn.lock` makes its repository a separate Yarn project. Yarn commands that run in such a repository, including `yarn workspace <name> <script>` issued from the outer root, look for an installation inside the repository and fail.

## Official Extensions

| Extension | Version | Description |
| ------ | ------ | ----------- |
| [yakumo-esbuild](./packages/esbuild/) | [![npm](https://img.shields.io/npm/v/yakumo-esbuild?style=flat-square)](https://www.npmjs.com/package/yakumo-esbuild) | execute [esbuild](https://esbuild.github.io) |
| [yakumo-mocha](./packages/mocha/) | [![npm](https://img.shields.io/npm/v/yakumo-mocha?style=flat-square)](https://www.npmjs.com/package/yakumo-mocha) | execute [mocha](https://mochajs.org) |
| [yakumo-tsc](./packages/tsc/) | [![npm](https://img.shields.io/npm/v/yakumo-tsc?style=flat-square)](https://www.npmjs.com/package/yakumo-tsc) | compile [TypeScript](https://www.typescriptlang.org) |
