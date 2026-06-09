# 会议合照生成器

内部会议纪要配图工具。用户可以选择或上传参会人员照片、会议地址照片、屏幕展示内容，并选择站位/座位、衣服、表情模式，随后调用图片模型生成自然逼真的会议合照。

## 启动

```bash
npm start
```

打开：

```text
http://127.0.0.1:5173/
```

## 测试

```bash
npm test
```

## 配置

复制 `.env.example` 为 `.env`，填入真实密钥和接口配置。

GPTSAPI `image-edit` 需要公网可访问的参考图 URL。推荐配置公网素材仓库：

```env
OPENAI_ASSET_UPLOAD_URL=https://你的上传地址/meeting-assets
OPENAI_ASSET_PUBLIC_BASE_URL=https://你的公网访问地址/meeting-assets
OPENAI_ASSET_UPLOAD_AUTHORIZATION=Bearer 你的上传令牌
```

如果上传接口不需要鉴权，可以删除 `OPENAI_ASSET_UPLOAD_AUTHORIZATION`。

也可以使用备用方案，把本工具通过公网 HTTPS 地址暴露，然后配置：

```env
OPENAI_ASSET_BASE_URL=https://你的公网工具地址
```

## 注意

- 不要提交 `.env`。
- 生成结果不会添加水印、角标或额外说明文字。
- 上传素材会按当前配置传给公网素材仓库或模型接口，请只上传允许用于内部会议纪要配图的图片。
