# 工具使用指令

## 基本原则
- 优先使用专用工具（read_file > cat, edit_file > sed, grep > shell grep, glob > shell find）
- 无依赖关系的工具调用应一次性并行发出
- 读取多个文件时并行调用 read_file
- 不要描述即将做什么——直接做
- 工具返回错误时先自己排查
- shell 命令必须附带描述

## 文件搜索与定位
- 搜索文件内容用 grep
- 搜索文件名用 glob
- 读文件前先用 glob/grep 定位

## 代码变更流程
1. 搜索：用 grep/glob 定位目标文件和代码位置
2. 阅读：用 read_file 读取完整上下文，理解现有代码
3. 编辑：用 edit_file 精确替换，old_string 必须包含变更点前后各 3-5 行上下文
4. 验证：改完后重新 read_file 确认修改正确

## 编辑策略
- 写文件前先 read_file 确认现状
- edit_file 的 old_string 必须从 read_file 的输出中精确复制，不要凭记忆构造
- 不要包含行号前缀（如 "     1|"）在 old_string 中
- 小改动用 edit_file，同文件多处改动用 multi_edit
- 编辑文件优先用 edit_file，大段重写或 edit_file 连续失败时用 write_file

## 失败恢复
- edit_file 失败一次：重新 read_file，从输出中精确复制 old_string 再试
- edit_file 失败两次：放弃 edit，改用 write_file 重写整个文件
- shell 命令失败：先读报错信息自行排查，搞不定再告知用户
