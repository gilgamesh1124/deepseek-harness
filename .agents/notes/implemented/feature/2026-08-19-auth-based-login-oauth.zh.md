# Agent Note：为仅 OAuth 认证的提供商（Codex）增加认证型登录

Status: implemented

[English](2026-08-19-auth-based-login-oauth.md) | 中文

## Problem

已装的 pi-ai 目录自带一个仅用 OAuth 认证的提供商——`openai-codex`。此前 harness 没有任何途径为它认证：`llm-pi-ai` 构造其 `Models` 集合时没有提供 pi-ai 凭据存储、不跑登录流，并把这个路由从可配置提供商目录中剔除，因为无论如何配置都无法让它工作。Codex / ChatGPT Plus/Pro 会员无法通过 dsh 使用其订阅；该路由上的请求在发出前就以 `Provider is not configured` 失败。

## Decision

`llm-pi-ai` 为 `createModels({ credentials })` 提供一个持久化的 pi-ai `CredentialStore`：新增一个基于文件的存储，位于 harness home 下的 `.oauth-credentials.json`，目录 `0700`、文件 `0600`，通过 `dsh-atomic-write` 做跨进程写锁。它实现 pi-ai 的 `read/list/modify/delete` 接口；`modify` 在其读-改-提交周期内持有写锁，使并发登录与自动刷新（包括来自其他进程的）不会复活另一个写入者刚轮换过的令牌。

一旦有存储，pi-ai 的 `Models.login()` 会运行 Codex OAuth 流程并把会员凭据持久化，`Models.getAuth()` 会在存储的串行 `modify` 内用 refresh token 刷新 access token，`Models.logout()` 则将其移除。由于适配器现在能为其认证，`openai-codex` 路由与 api-key 路由一样被列入可配置提供商目录；一个 profile（哪怕是空的 `{}`）即可激活它。

登录与登出通过人类命令通道进行（`/llm-login`、`/llm-logout`、`/llm-auth`），经一个 `CommandInteraction` 用命令参数回答流程的方法选择与手动填码提示，并捕获每一个设备码 / 授权 URL 事件用于呈现。无头设备码流程为默认；浏览器流程通过 `--paste` 接收粘贴的授权码。存储位置是插件配置（`oauthStorePath`/`dshHome`），永不是密钥——文件本身保存令牌。

## Alternatives considered

**在 dsh 里重写 Codex OAuth 流程**——否决。pi-ai（已是依赖）自带完整且持续维护的 `openaiCodexOAuth`（PKCE 浏览器 + 设备码流程、刷新、`toAuth` → bearer access token），harness 也已有令牌持久化模式；重写会重复维护并增加漂移风险，且无消费者收益。

**只通过 Web RPC + 设置页卡片暴露登录**——延后。人类命令通道是首个交付的界面；专门的 Web 登录卡片是后续工作，因为设备码流程已能经 `ctx.commands` 呈现，无需新 UI。

**OS 钥匙串凭据存储**——延后。`0600`/`0700` 文件与现有环境凭据姿态一致且可在进程内测试；模型进程无法读取的钥匙串存储仍是后续的兄弟包工作。

## Consequences

代价：存储基于文件，因此同一 UID 的进程能像读取用户拥有的任何文件那样读取令牌（边界不比现有环境凭据文件更强）。真实会员使用需要一次性交互式登录和 keyless 测试无法覆盖的实时请求。经第三方客户端使用 ChatGPT 后端的会员令牌处于 ToS 灰色地带，且端点会变动，因此不承诺稳定性。

收益：Codex/ChatGPT 会员成为一等公民、自动刷新的凭据路径，无需 API key，跨重启持久化，且目录不再隐藏用户实际可以配置的路由。自动刷新能让请求持续工作，直到 refresh token 自身被吊销；此后会以清晰的 `AUTH` 错误提示用户重新执行 `/llm-login`。
