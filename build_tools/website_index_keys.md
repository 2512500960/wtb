# 网站索引（Ed25519）密钥生成与使用

本项目网站索引签名已切换为 **Ed25519**（椭圆曲线）。

## 1) 生成私钥/公钥（OpenSSL，带密码私钥）

生成未加密私钥：

- `openssl genpkey -algorithm ED25519 -out index_sign_private.pem`

将私钥转换为加密 PKCS#8（会提示输入密码）：

- `openssl pkcs8 -topk8 -in index_sign_private.pem -out index_sign_private.enc.pem -v2 aes-256-cbc`

导出公钥（会提示私钥密码）：

- `openssl pkey -in index_sign_private.enc.pem -pubout -out index_sign_public.pem`

## 2) 签名 payload.json 并输出 index.json

需要先安装依赖：

- `python -m pip install pycryptodome`

使用加密私钥签名（会提示输入密码）：

- `python build_tools/sign_website_index.py --private-key index_sign_private.enc.pem`

默认输出到：`wtb-data/web/index.json`

## 3) 配置应用验签公钥

将 `index_sign_public.pem` 的 PEM 全文本，硬编码到：

- `src/main/website_index_pubkey.ts`

索引地址（可选）：

- `WTB_WEBSITE_INDEX_DATA_URL`：指向你的 web 服务器上的 `index.json`
