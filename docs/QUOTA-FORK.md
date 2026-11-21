# 周额度开席策略与镜像发布

控制台「设置 → 调度 → 分配策略」新增「周额度进度」。保存后，新 Claude 对话在可用账号中优先选择「7 天剩余额度比例 ÷ 本周期剩余时间比例」最高的账号。原有会话绑定、账号限额、并发和内存保护仍适用。缺少有效周额度数据的账号排在有数据的账号之后，同分时沿用平衡排序。排队的新对话按同一规则开席。面板显示的是估算顺序，实时并发和主机状态可能改变落点。

[发布工作流](../.github/workflows/quota-image.yml) 在 fork 的默认分支生效。将改动推送到默认分支后，在 GitHub 的 Actions 页启用已禁用的 fork 工作流，然后手动运行一次 **Track vm2api releases and publish quota image**。可指定官方版本，例如 `v1.4.171`，或留空使用最新正式版。关闭 Publish 可以验证镜像构建而不发布。

工作流每 6 小时检查官方 Release，将 fork 的改动应用到正式标签，运行调度测试，重新构建控制台，并在同版本官方 amd64 镜像上替换应用文件。镜像发布到独立的 `vm2api-quota` 包，标签包含官方版本和补丁摘要，例如 `ghcr.io/hibanaw/vm2api-quota:v1.4.171-quota.<hash>-amd64`。补丁冲突、官方镜像尚未发布、源码与镜像不匹配或测试失败都会停止发布。

保留 fork 默认分支作为补丁来源。版本跟踪在 Actions 中完成，该工作流不会合并上游分支或推送提交。手动同步官方分支后，需要检查工作流中的补丁基准和差异范围。镜像首次发布后，在 GitHub Packages 确认服务器的拉取权限。

Actions 在镜像可匿名拉取后发布 [fork Release](https://github.com/Hibanaw/vm2api/releases)。带定制更新入口的镜像只从这些 Release 检查更新；「从面板发起」使用相同的镜像标签。

首次从官方镜像切换，或在宿主机手动更新时，运行：

```bash
curl -fsSL https://raw.githubusercontent.com/Hibanaw/vm2api/dev/deploy/upgrade-quota.sh | sudo bash -s -- upgrade
```

脚本识别名为 `vm2api` 的 amd64 Compose 容器，备份 `.env` 和 SQLite 数据库，再重建控制面并验证原本健康的槽位。可以用 `check` 查看最新标签，或者用 `upgrade --version TAG` 选择已发布的版本。更新日志可用 `docker logs vm2api-upgrade-vm2api` 查看，备份留在服务器的 `deployment-backups/`。
