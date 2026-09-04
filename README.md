# BoundLess Support v0.1

一个独立部署的 **Crisp 托管、客服后台与 Telegram 双向同步系统**。访客继续使用 Crisp 官方聊天组件，本系统负责消息归档、关键词回复和 Telegram 分流。

## 本版已经实现

- MySQL 会话、访客和聊天记录
- Socket.IO 实时收发消息
- 客服管理后台三栏布局
- 未读计数、搜索、关闭/重新打开会话
- 图片与文件上传
- 多网站数据模型（`sites` 表）
- Telegram 超级群组双向同步（每个网站一个群组、每个会话一个话题）
- Crisp 托管模式（Crisp、客服后台与 Telegram 三端双向同步）
- 多关键词自动回复规则
- 使用已有 MySQL，Docker Compose 只启动客服服务

## 1. 启动

先在已有 MySQL 中创建一个数据库和用户，字符集使用 `utf8mb4`，排序规则使用 `utf8mb4_unicode_ci`。客服程序第一次连接时会自动创建所需数据表，不需要手动导入 SQL；以后升级时也会保留已有数据并补齐缺少的表。

例如使用 MySQL 管理员账号执行：

```sql
CREATE DATABASE support_chat CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'support'@'%' IDENTIFIED BY '数据库密码';
GRANT ALL PRIVILEGES ON support_chat.* TO 'support'@'%';
FLUSH PRIVILEGES;
```

已有同名用户时使用 `ALTER USER` 修改密码，不要重复创建。`'%'` 允许客服容器连接；也可以按你的 Docker 网段进一步限制来源。

```bash
cp .env.example .env
```

`.env` 只保存服务启动前必须知道的基础设施信息，例如数据库连接、监听端口和首次管理员登录。Telegram、网站和身份识别等业务配置全部在管理网页中完成。

至少修改：

```env
JWT_SECRET=一个足够长的随机字符串
DB_HOST=MySQL 地址
DB_NAME=数据库名称
DB_USER=数据库用户名
DB_PASSWORD=数据库密码
ADMIN_EMAIL=你的客服登录邮箱
ADMIN_PASSWORD=强密码
```

Docker Compose 只启动客服服务，不会创建 MySQL 容器。如果 MySQL 运行在同一台服务器并开放了宿主机端口，`DB_HOST` 可以使用 `host.docker.internal`；如果 MySQL 是另一个容器，则填写客服容器可以访问的 MySQL 容器名或地址，并确保两个容器网络互通。容器里的 `127.0.0.1` 指向客服容器自身，不能用来连接宿主机 MySQL。

然后：

```bash
docker compose up -d --build
```

默认端口：`3180`

访问：

- 客服后台：`http://服务器IP:3180/admin/`
- 健康检查：`http://服务器IP:3180/api/health`

## 2. 反向代理

1Panel / OpenResty 可参考 `nginx-example.conf`。

生产环境建议使用：

```text
https://support.example.com
```

并开启 HTTPS。

## 3. 网站管理

管理员登录 `/admin/` 后进入“网站接入”：

1. 输入完整网站地址，例如 `https://panel.example.com`。
2. 点击“添加”，网站会进入选择列表，用于隔离 Crisp 会话、关键词和 Telegram 群组。
3. 在 Crisp 托管区域填写该网站对应的 Crisp 凭证。

每个网站都应单独添加，并绑定自己的 Crisp Website ID 和 Telegram 群组。

## 4. Crisp 托管模式

系统管理页只提供 Crisp 托管配置。访客继续使用 Crisp 官方聊天组件，本系统负责保存会话、显示管理面板、执行关键词回复并同步 Telegram。

1. 在 Crisp Dashboard 打开 `Settings > Workspace Settings > Advanced configuration > API Token`，生成 Website Token。
2. 在本系统选择网站，填写 Crisp Website ID、Website Token ID 和 Website Token Key，然后保存并测试连接。
3. 复制后台生成的 Website Hook 回调地址。
4. 在 Crisp 的 `Advanced configuration > Web Hooks` 添加该地址，并订阅 `message:send` 和 `message:received`。
5. 目标网站继续使用 Crisp 官方提供的聊天组件代码，本系统不再生成或接管组件 HTML。

消息同步关系：

- Crisp 访客消息会进入本系统管理面板和该会话对应的 Telegram Topic。
- 管理面板或 Telegram Topic 中的回复会通过 Crisp API 回到同一访客会话。
- 从 Crisp Dashboard 直接发送的客服回复也会同步到本系统和 Telegram。
- Crisp 图片与文件会保留原始云端地址并同步；本系统上传的附件需要公网地址可访问。
- 关键词回复会作为 Crisp 客服消息发送，并同时显示在管理面板和 Telegram。
- 新建 Telegram Topic 时会先发送访客资料：登录状态、用户、邮箱、地区、操作系统、浏览器、Crisp 自定义字段及最近 10 条访问记录。访问记录由 Crisp REST API 读取，Website Hook 仍只需订阅 `message:send` 和 `message:received`。
- 管理后台通过 Crisp REST API 同步访客在线状态：会话列表每 30 秒批量更新最近会话，打开的会话每 15 秒单独确认一次。`session:update_availability` 只支持 Crisp Plugin Hook，因此 Website Hook 中不需要额外勾选该事件。

Crisp Website Hook 本身不提供签名。本系统会为每个网站生成独立的随机回调密钥，并校验 Website ID 和消息指纹；重复回调不会重复入库。Website Token 和回调密钥均加密保存在 MySQL 中。

## 5. 多网站会话

客服后台按照网站地址对会话分组。同一网站的访客出现在同一组，不同网站的数据使用各自的站点标识隔离。

## 6. Telegram 双向同步

1. 在 Telegram 的 `@BotFather` 创建机器人并取得 Bot Token。
2. 创建一个超级群组，开启 Topics（话题）功能。
3. 把机器人设为群组管理员，并允许发送消息、文件和管理话题。
4. 如机器人收不到话题内的普通回复，在 `@BotFather` 使用 `/setprivacy` 为该机器人关闭 Privacy Mode。
5. 进入后台“网站接入”，填写公网 HTTPS 客服地址和 Bot Token；Webhook 密钥可以留空，由系统自动生成。
6. 点击“保存系统配置”，然后在目标群组发送一条消息。
7. 点击“读取群组”，选择或填入该网站的超级群组 ID，再点击“保存群组”。
8. 点击“启用 Webhook”。所有修改立即生效，不需要重启服务。

“读取群组”使用 Telegram 官方接口查找机器人最近收到消息的群组。如果 Webhook 已启用，系统会临时停止 Webhook，读取完成后立即恢复，过程中不会清空待处理消息。Webhook 按钮会根据 Telegram 的实际状态切换为“启用 Webhook”或“停止 Webhook”。不要把 Bot Token 发给其他机器人、网页或第三方查询服务。

同步关系如下：

- 一个网站对应一个 Telegram 超级群组。
- 一个网页会话对应群组内的一个 Forum Topic。
- 访客从 Crisp 发出的消息会进入网页后台和对应话题。
- 网页后台回复会进入 Crisp 和对应话题。
- 管理员在对应话题回复会写入 MySQL，并实时出现在网页后台和 Crisp。

MySQL 是唯一消息数据源。Telegram 暂时不可用时，网页聊天仍可使用，待发送消息会由出站队列自动重试。Telegram Webhook 的消息不会再次回发到 Telegram，因此不会形成重复回声。

## 7. 关键词自动回复

管理员可以在“网站接入”页面为当前网站维护关键词规则：

1. 选择网站，填写关键词和回复内容。
2. “包含关键词”会在访客消息包含该文字时触发；“完全一致”只在整条消息一致时触发。
3. 每条规则都可以随时编辑、启用、停用或删除。

匹配不区分英文字母大小写，并会统一全角、半角字符。同一条消息只触发一条回复：完全一致优先，其次优先使用更长的关键词。自动回复作为客服消息保存到 MySQL，并同步显示在 Crisp、网页后台和对应的 Telegram Topic 中。每个网站的规则彼此独立。

## 8. 项目结构

```text
crisp-like-support/
├── server/
│   ├── index.js
│   ├── crisp.js
│   ├── settings.js
│   ├── telegram.js
│   └── schema.sql
├── public/admin/
├── uploads/
├── data/                 # 自动生成的配置加密主密钥
├── docker-compose.yml
├── Dockerfile
├── nginx-example.conf
└── README.md
```

## 下一阶段建议

后续可继续增加：多客服账号、客服分配、快捷回复、标签、内部备注、输入中状态、已读回执、工作时间、消息撤回和统计页。
