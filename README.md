<h1 align="center">AinCode</h1>
<p align="center">The open source AI coding agent, by <a href="https://ainetwork.ai">AI Network</a>.</p>
<p align="center">
  <a href="README.md">English</a> |
  <a href="README.ko.md">한국어</a>
</p>

---

AinCode is AI Network's fork of [OpenCode](https://github.com/anomalyco/opencode), the open source AI coding agent.
It tracks upstream OpenCode closely and adds AI Network specific branding and integrations on top.

- Repository: [github.com/ainetwork-ai/AinCode](https://github.com/ainetwork-ai/AinCode)
- Upstream: [github.com/anomalyco/opencode](https://github.com/anomalyco/opencode)

> [!NOTE]
> AinCode is not built by or affiliated with the OpenCode team.
> Configuration files, environment variables and plugins remain compatible with OpenCode
> (`opencode.json`, `~/.config/opencode`, `OPENCODE_*`), so upstream documentation applies.

### Installation

There is no packaged AinCode release yet. Build and run from source with [Bun](https://bun.sh):

```bash
git clone https://github.com/ainetwork-ai/AinCode.git
cd AinCode
bun install
bun dev            # run the CLI/TUI in the current directory
bun dev --help     # show the `aincode` command reference
```

### Agents

AinCode includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

### Documentation

AinCode follows the upstream OpenCode documentation: [opencode.ai/docs](https://opencode.ai/docs).

### Syncing with upstream

```bash
git remote add upstream https://github.com/anomalyco/opencode.git
git fetch upstream
git merge upstream/dev
```

### Contributing

Please read the [contributing docs](./CONTRIBUTING.md) before submitting a pull request to
[ainetwork-ai/AinCode](https://github.com/ainetwork-ai/AinCode).

### License

MIT, same as upstream OpenCode. See [LICENSE](./LICENSE).
