-- 移除一个早期演示用的占位列。
--
-- profiles 的读取策略是「登录即可读全部行」（为了让聊天时能显示对方昵称与头像），
-- 而这一列存的是明文默认值，等于任何登录用户都能通过接口读到全部账号的支付密码；
-- 它并不参与任何校验（余额支付密码走前端演示逻辑），所以直接删掉，避免留隐患。
alter table public.profiles drop column if exists pay_password;
