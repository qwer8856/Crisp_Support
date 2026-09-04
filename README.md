# Crisp Support

一个自托管的 Crisp 客服托管系统，用于把 Crisp、客服网页后台和 Telegram 超级群组连接起来。

主要功能：

- 接收并保存 Crisp 访客消息
- 网页后台和 Telegram 双向回复
- 按网站划分会话和 Telegram 群组
- 多关键词自动回复
- 同步访客资料、在线状态、图片和文件
- 所有业务配置均可在管理网页中完成

## 简单部署

### 1. 创建 MySQL 数据库

登录服务器已有的 MySQL：

```bash
mysql -u root -p
```

执行：

```sql
CREATE DATABASE support_chat CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'support'@'%' IDENTIFIED BY '请修改为数据库密码';
GRANT ALL PRIVILEGES ON support_chat.* TO 'support'@'%';
FLUSH PRIVILEGES;
EXIT;
```

如果已经存在 `support` 用户，请使用现有用户或执行 `ALTER USER` 修改密码，不要重复创建。

### 2. 在 `/root` 创建项目文件夹

```bash
mkdir -p /root/Crisp_Support
cd /root/Crisp_Support
git clone https://github.com/qwer8856/Crisp_Support.git .
```

### 3. 修改 `.env`

```bash
cp .env.example .env
nano .env
```

至少修改以下内容：

```env
JWT_SECRET=请填写足够长的随机字符串
DB_HOST=host.docker.internal
DB_PORT=3306
DB_NAME=support_chat
DB_USER=support
DB_PASSWORD=请填写数据库密码
ADMIN_EMAIL=请填写管理员邮箱
ADMIN_PASSWORD=请填写管理员密码
```

如果 MySQL 在其他服务器或其他 Docker 容器中，请把 `DB_HOST` 改成客服容器能够访问的 MySQL 地址。

### 4. 构建并启动

```bash
docker compose up -d --build
```

容器名称为 `Crisp_Support`，默认使用 `3180` 端口。

### 5. 打开后台

```text
http://服务器IP:3180/admin/
```

生产环境建议配置 HTTPS 反向代理，可参考 `nginx-example.conf`。

## 后台接入

登录后台后按顺序完成：

1. 添加需要托管的网站地址。
2. 填写 Crisp Website ID、Website Token ID 和 Website Token Key。
3. 把后台生成的 Website Hook 地址添加到 Crisp，并订阅 `message:send` 和 `message:received`。
4. 填写 Telegram Bot Token，绑定网站对应的超级群组，然后启用 Webhook。
5. 根据需要添加关键词自动回复规则。

## 更新

```bash
cd /root/Crisp_Support
git pull --ff-only
docker compose up -d --build
```

运行数据保存在 `data/` 和 `uploads/`，`.env`、密钥、数据库数据和上传文件不会提交到 GitHub。
