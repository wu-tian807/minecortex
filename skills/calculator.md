---
name: calculator
description: 用 shell 工具做数学计算
globs: ["*"]
---

## Calculator Skill

需要计算时，用 shell 工具执行：

```bash
echo "表达式" | bc -l
```

例如：
- `echo "10 + 5" | bc`
- `echo "100 / 7" | bc -l`
- `echo "2^10" | bc`
