# Tollfree

**Don't just build. Prove it.**

TOLLFREE is a governance layer for AI coding agents. It automatically selects the right orchestration level, agents, models, and controls based on task complexity and risk — then requires verifiable proof before considering work done.

---

## 📋 Table of Contents

1. [Features](#-features)
2. [Architecture](#-architecture)
3. [Installation](#-installation)
4. [Usage](#-usage)
5. [Security](#-security)
6. [Monitoring](#-monitoring)
7. [Advanced Configuration](#-advanced-configuration)
8. [Troubleshooting](#-troubleshooting)
9. [Documentation](#-documentation)
10. [Contribution](#-contribution)
11. [License](#-license)

---

## ✨ Features

- **Models (free tiers, strict quotas)**: Groq, Google, Zhipu, Novita AI (**FREE**, 256K ctx), SambaNova, Pollinations (keyless), Cerebras (trial), Ollama (local), Cohere (trial) — see `docs/02-configuration-en.md` §3
- **TOLLFREE Supervisor**: Automatic provider rotation on quota/error
- **25 agents**: 15 role agents (planner, architect, design-lead, builder, quality-engineer, tester, security, reviewer, git-engineer, docwriter, auditor, integrator, verifier, quota-guard, tollfree) + 10 free/trial workers
- **Circuit breaker**: Protection against failing providers (CLOSED/OPEN/HALF_OPEN)
- **Local quota tracking**: Daily count per provider/model to prevent overuse
- **direct wrapper**: Bypass of the `opencode run` bug (Windows SDK workaround, optional on macOS/Linux)
- **Audit logger**: JSONL logging of tool calls with sensitive ops detection and redaction
- **Custom commands**: `/run`, `/direct`, `/audit-log`, `/commit`, `/review`, `/quota`, `/mode`, `/free-test`
- **Plugins**: `better-compact`, `opencode-mem`, `envsitter-guard`, `oh-my-opencode-slim`, `opencode-plugin-preload-skills`, guard.ts, audit-logger.ts, auto-compact.ts
- **Skill matrix**: Intelligent routing of tasks by complexity (L1-L4)

---

## 🏗️ Architecture

```
~/.config/opencode/
├── 📄 opencode.jsonc              # Main OpenCode configuration
├── 📄 opencode.json               # Legacy configuration (backup)
├── 📄 opencode-mem.jsonc          # Long-term memory configuration
├── 📄 tui.json                    # TUI configuration
├── 📄 AGENTS.md                   # Default agent instructions
├── 📄 CONFIG-GUIDE.md            # Quick configuration guide
├── 📄 .gitignore                 # Sensitive file exclusions
├── 📁 agent/                     # 25 specialized agents
│   ├── tollfree.md              # Main supervisor
│   ├── planner.md                # Task planning
│   ├── architect.md              # Technical architecture
│   ├── design-lead.md            # Design direction
│   ├── builder.md                # Code execution
│   ├── quality-engineer.md       # Quality and testing
│   ├── tester.md                 # Automated tests
│   ├── security.md               # Security
│   ├── reviewer.md               # Code review
│   ├── git-engineer.md           # Git management
│   ├── docwriter.md              # Documentation
│   ├── auditor.md                # Audit
│   ├── integrator.md             # Integration
│   ├── verifier.md               # Verification
│   ├── quota-guard.md            # Quota guard
│   └── worker-*.md              # Fallback workers (10)
├── 📁 command/                   # 8 slash commands
│   ├── audit-log.md              # Audit log
│   ├── commit.md                 # Git commit
│   ├── direct.md            # Direct provider access
│   ├── free-test.md       # Free model testing
│   ├── quota.md                  # Quota management
│   ├── review.md                 # Code review
│   └── run.md                    # opencode run wrapper
├── 📁 plugin/                    # 3 TypeScript plugins
│   ├── audit-logger.ts           # JSONL logging
│   ├── guard.ts                  # Destructive protection + secret redaction
│   └── auto-compact.ts           # Intelligent compaction
├── 📁 scripts/                   # 12 scripts (Python, Node, TypeScript)
│   ├── session-review.mjs        # Session review
│   └── verify-golden.ts          # Golden test verification
├── 📁 skills/                    # 30+ skills
│   ├── tollfree-agent-matrix/        # L1-L4 routing
│   ├── tollfree-code-navigation/     # Efficient codebase search
│   ├── tollfree-token-efficiency/    # Token optimization
│   ├── tollfree-verification/        # Proportional verification
│   └── tollfree-enterprise-development/ # Enterprise development
├── 📁 docs/                      # Technical documentation (FR/EN)
├── 📁 logs/                      # Audit logs (JSONL)
└── 📁 node_modules/              # Installed dependencies
```

### Data Flow

```
User
    │
    ├─ opencode run "prompt" ──► tollfree direct ──► tollfree direct
    │                                                                    │
    │                                                                    ├─► Circuit breaker (provider_circuit.json)
    │                                                                    ├─► Quota tracking (provider_usage.json)
    │                                                                    └─► API calls (Groq, Google, Zhipu, etc.)
    │
    └─ opencode agent "task" ──► Agent (tollfree/planner/etc.)
                                    │
                                    ├─► opencode run (if bug) ──► tollfree direct
                                    └─► opencode native (if working)
```

### Agent Model Assignment

| Agent | Role | Model | Provider |
|-------|------|--------|----------|
| **tollfree** | Supervisor | `google/gemini-2.5-flash` | Google (FREE) |
| **planner** | Planning | `google/gemini-2.5-flash` | Google (FREE) |
| **architect** | Architecture | `google/gemini-2.5-flash` | Google (FREE) |
| **design-lead** | Design | `google/gemini-2.5-flash` | Google (FREE) |
| **builder** | Execution | `google/gemini-2.5-flash` | Google (FREE) |
| **quality-engineer** | Quality | `google/gemini-2.5-flash` | Google (FREE) |
| **tester** | Testing | `google/gemini-2.5-flash` | Google (FREE) |
| **security** | Security | `google/gemini-2.5-flash` | Google (FREE) |
| **reviewer** | Review | `google/gemini-2.5-flash` | Google (FREE) |
| **git-engineer** | Git | `google/gemini-2.5-flash` | Google (FREE) |
| **docwriter** | Docs | `google/gemini-2.5-flash` | Google (FREE) |
| **auditor** | Audit | `google/gemini-2.5-flash` | Google (FREE) |
| **integrator** | Integration | `google/gemini-2.5-flash` | Google (FREE) |
| **verifier** | Verification | `google/gemini-2.5-flash` | Google (FREE) |
| **quota-guard** | Quota guard | `google/gemini-2.5-flash` | Google (FREE) |
| **worker-opencode** | Worker | `opencode/deepseek-v4-flash-free` | Integrated (0 quota) |
| **worker-opencode-heavy** | Worker | `opencode/glm-5-free` | Integrated (0 quota) |
| **worker-codestral** | Worker | `openrouter/poolside/laguna-s-2.1:free` | OpenRouter (FREE) |
| **worker-groq** | Worker | `groq/qwen/qwen3.8-27b` | Groq (FREE tier) |
| **worker-novita** | Worker | `novita/inclusionai/ling-3.0-flash-sante` | Novita (FREE) |
| **worker-zhipu** | Worker | `zhipu/glm-4.7-flash` | Zhipu (FREE tier) |
| **worker-google** | Worker | `google/gemini-2.5-flash` | Google (FREE tier) |
| **worker-pollinations** | Worker | `pollinations/openai` | Pollinations (keyless) |
| **worker-ollama** | Worker | `ollama/devstral` | Local (offline) |
| **worker-zenmux** | Worker | `zenmux/anthropic/claude-sonnet-5-free` | ZenMux (PAYG) |

---

## 🛠️ Installation

### Requirements

- [OpenCode](https://opencode.ai/) installed
- Node.js 18+ (Linux, macOS or Windows). Python is no longer needed.
- Optional: free API keys (Groq, Google, Zhipu, OpenRouter, Novita…); with no key, OpenCode's built-in free models already work.

### In 3 commands

```bash
npm install -g tollfree     # or: pnpm add -g tollfree
tollfree init               # installs agents, commands, skills and guardrails
tollfree doctor             # checks that everything is in place
```

> **Status:** the package is not published on npm yet. Meanwhile, from a clone:
> `git clone <this repo> && cd <folder> && npm install && npm run build && npm link`, then `tollfree init`.

`tollfree init` **adapts to the machine**:

- detects your keys (env vars `GROQ_API_KEY`, `GEMINI_API_KEY`, `ZHIPU_API_KEY`, `OPENROUTER_API_KEY`, `NOVITA_API_KEY`… or `.groq-key`… files) and installs only the workers you can use;
- notices a local Ollama;
- swaps the model of an agent whose key is missing for a free built-in model (`--fallback-model` to pick another);
- never overwrites an existing file you edited (`--force` backs it up, then replaces it);
- leaves an existing `opencode.jsonc` alone (`--set-default` only adds `"default_agent": "tollfree"`).

| Command | What it does |
|---|---|
| `tollfree init [--global \| --project \| --dir <path>] [--dry-run]` | Install (global by default, or into `./.opencode` for one project) |
| `tollfree update` | Update without touching your edits; follows keys you add or remove |
| `tollfree uninstall [--purge]` | Remove only what was installed and restore your original files |
| `tollfree doctor [--json]` | Diagnose Node, OpenCode, keys, Ollama and file integrity |

The target is OpenCode's config dir (`~/.config/opencode`, or `$XDG_CONFIG_HOME/opencode`); set `TOLLFREE_DIR` to use another.
Each install writes `.tollfree/manifest.json` (files and hashes), which is what makes `update` and `uninstall` safe.

> Agents run the `tollfree` command in a terminal, so it must be on your `PATH` (`npm install -g`), not only run through `npx`.

### API keys (optional)

Easiest: export the provider's environment variable, then `tollfree update`. Otherwise a one-line file in the config dir:

```bash
echo "YOUR_KEY" > ~/.config/opencode/.groq-key     # same for .gemini-key, .zhipu-key, .openrouter-key, .novita-key
```

### Platforms

| OS | Notes |
|----|-------|
| **Windows** | Node 18+ is enough. Agent commands use `bash` (Git Bash or WSL), like OpenCode. |
| **macOS / Linux** | Works natively. |

---

## 🚀 Usage

### Custom Commands

- `/run "your prompt"` → Uses direct wrapper with automatic fallback
- `/direct [options] "prompt"` → Direct provider access with fine-grained control
- `/audit-log` → Displays the audit log (JSONL)
- `/commit` → Intelligent Git commit
- `/review` → Code review
- `/quota` → Quota management
- `/mode` → Switch mode (FREE/PRO)
- `/free-test` → Full free model testing

### direct Options

```bash
--model SPECIFIC    Use a specific model
--provider SPECIFIC Force a provider (groq, mistral, zhipu, etc.)
--task-type TYPE    Task type (code|chat|auto)
--max-tokens N      Max tokens (default: 2048)
--temperature F     Temperature (default: 0.2)
--json              Raw JSON output
--reset-quota       Reset quota counters
--reset-circuit     Reset circuit breakers
--status            Show quota + circuit state
--list              List all available models
--list-providers    List configured providers
```

### TOLLFREE Routing

```bash
# Find the best worker for a task type
tollfree route code

# Find the fallback worker
tollfree route code --next

# List all workers with status
tollfree route list

# Record a result (Bayesian feedback)
tollfree route record worker-groq success
```

---

## 🔒 Security

- **API keys excluded**: All `.*-key`, `.env`, `provider_*.json` are in `.gitignore`
- **Secret redaction**: Audit logger automatically masks tokens, passwords, etc.
- **Sensitive ops detection**: Monitoring of dangerous commands (rm, dd, mkfs, etc.)
- **Log rotation**: Audit files rotated every 30 days
- **No sensitive data versioned**: Only configuration code is public

---

## 📊 Monitoring

### State Files

- `provider_usage.json`: Daily call counter
- `provider_circuit.json`: Circuit breaker state
- `logs/audit-YYYY-MM-DD.jsonl`: Detailed audit log
- `free-models.json`: Real-time worker status
- `route-usage.json`: Success/failure history (Bayesian feedback)

### Useful Commands

```bash
# View system state
opencode /run --status

# Test a specific provider
opencode /direct --provider groq "explain recursion"

# List available models
opencode /direct --list

# Reset quotas (for testing)
opencode /direct --reset-quota

# View audit log
opencode /audit-log

# Test all free models
opencode /free-test
```

---

## ⚙️ Advanced Configuration

### opencode.jsonc

The main configuration defines:
- `default_agent`: "tollfree"
- `small_model`: "google/gemini-2.5-flash"
- Bash and skills permissions
- Free/trial providers by default, paid entries clearly marked (Mammouth as optional fallback)
- MCP servers (Postgres for memory)

### Custom Skills

- `tollfree-agent-matrix`: L1-L4 routing by complexity
- `tollfree-token-efficiency`: Token optimization
- `tollfree-code-navigation`: Efficient codebase search
- `tollfree-verification`: Proportional verification
- `tollfree-enterprise-development`: Enterprise development
- `tollfree-verification`: Verification before completion

---

## 🆘 Troubleshooting

### Common Issues

1. **"Creating a session failed"** → Check that `opencode.json` (legacy) does not have `permission.task: "deny"` (rename to `.bak`)
2. **Opencode run hangs** → Use `/run` or `/direct` instead (Windows SDK bug workaround — macOS/Linux: `opencode run` works natively)
3. **Quota exhausted** → Circuit breaker automatically switches to the next provider
4. **Provider error 429** → Check `provider_circuit.json` and wait for timeout to end
5. **Missing API key** → Create the corresponding `.xxx-key` file
6. **Plugin not loading** → Check that `node_modules` is installed (`npm install`)

### Logs

- Consult `logs/audit-YYYY-MM-DD.jsonl` to see all tool calls
- Provider errors are logged with context for debugging

---

## 📚 Documentation

Complete documentation is available in `docs/` (in English and French):

| Document | Description |
|----------|-------------|
| [Architecture](docs/01-architecture-en.md) | Technical architecture, providers, TOLLFREE protocol |
| [Configuration](docs/02-configuration-en.md) | Full configuration guide |
| [Agents](docs/03-agents-en.md) | All 25 agents documented |
| [Scripts](docs/04-scripts-en.md) | Python scripts reference |
| [Plugins](docs/05-plugins-en.md) | TypeScript plugins |
| [Commands](docs/06-commands-en.md) | Slash commands |
| [Skills](docs/07-skills-en.md) | Custom skills |
| [Troubleshooting](docs/08-troubleshooting-en.md) | Common issues and solutions |
| [Security](docs/09-security-en.md) | Security best practices |
| [Summary](docs/10-summary-en.md) | Project summary |
| [Examples](docs/11-examples-en.md) | Governance examples |

---

## 🤝 Contribution

Improvements are welcome! To contribute:

1. Fork the repository
2. Create a branch for your feature
3. Commit your changes
4. Open a Pull Request

---

## 📄 License

MIT — Adapt to your needs.

---

## 🙏 Acknowledgments

- OpenCode team for the excellent tool
- Free providers (Groq, Mistral, etc.) for their APIs
- Open source community for inspiration

---

*Configuration maintained with love by Tollfree*
*Last update: 2026-09-19*

---

## 🔗 Useful Links

- [OpenCode](https://opencode.ai/) — AI coding tool
- [OpenCode GitHub](https://github.com/sst/opencode) — Source repository
- [Groq](https://groq.com/) — Free API (free tier)
- [Google AI Studio](https://aistudio.google.com/) — Free Gemini
- [Novita AI](https://novita.ai/) — Free API (256K ctx)
- [Zhipu AI](https://open.bigmodel.cn/) — Free GLM
- [OpenRouter](https://openrouter.ai/) — Access to free models
- [Hugging Face](https://huggingface.co/) — Open source models
- [Ollama](https://ollama.com/) — Local models
- [Pollinations](https://pollinations.ai/) — Keyless API
- [ZenMux](https://zenmux.ai/) — Claude Sonnet 5 free
- [Bun](https://bun.sh/) — Fast JavaScript runtime
- [Node.js](https://nodejs.org/) — JavaScript environment