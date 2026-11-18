# rulepress

Chuyển rule TOML của Elastic thành NDJSON để import thẳng vào Kibana.

Repo [elastic/detection-rules](https://github.com/elastic/detection-rules) phát hành rule dạng TOML, nhưng
**Detection rules → Import** của Kibana chỉ nhận NDJSON. `rulepress` làm phần chuyển đổi đó, và không chỉ
`toml → json` thô: nó áp đúng cách Elastic build payload, nên rule import được thật.

**[→ Bắt đầu nhanh: từ số 0 đến Kibana trong 5 bước](QUICKSTART.md)** · [English](README.md)

## Cài đặt

**Windows**

```powershell
irm https://raw.githubusercontent.com/TuanCui22/rulepress/master/install.ps1 | iex
```

**Linux / macOS**

```bash
curl -fsSL https://raw.githubusercontent.com/TuanCui22/rulepress/master/install.sh | bash
```

**Dùng npm, áp dụng cho mọi hệ điều hành**

```bash
npm install -g rulepress
```

**Không cài, chạy trực tiếp từ bản clone**

```bash
git clone https://github.com/TuanCui22/rulepress.git
cd rulepress
npm install
node bin/rulepress.js --help
```

Cần Node 18 trở lên. CLI tự kiểm tra khi khởi động và hướng dẫn cách nâng cấp nếu Node quá cũ.

## Cách dùng

```bash
rulepress <input...> [options]
```

`<input>` là một hoặc nhiều file `.toml`, hoặc thư mục (sẽ quét đệ quy).

```bash
# mỗi rule một file, ghi vào ./ndjson
rulepress rules/

# gộp tất cả vào một file để import một lần
rulepress rules/ --bundle rules.ndjson

# xem trước sẽ làm gì, không ghi gì cả
rulepress rules/ --dry-run

# tự chuyển lại mỗi khi sửa file
rulepress rules/ --bundle rules.ndjson --watch

# dùng trong CI: chuyển và kiểm tra, không ghi, fail nếu có cảnh báo
rulepress rules/ --check --strict
```

### Tuỳ chọn

| Tuỳ chọn | Ý nghĩa |
|---|---|
| `-o, --out <dir>` | Thư mục output (mặc định `./ndjson`) |
| `--bundle <file>` | Gộp mọi rule vào một file NDJSON |
| `--dry-run` | Xem trước sẽ ghi gì, không ghi gì |
| `--force` | Ghi đè file output đã có |
| `--watch` | Chuyển lại khi file `.toml` thay đổi |
| `--open` | Mở thư mục output sau khi xong |
| `--init` | Tạo `rulepress.config.json` với cấu hình mặc định |
| `--check` | Chỉ chuyển và kiểm tra, không ghi |
| `--strict` | Coi cảnh báo là lỗi (nên dùng trong CI) |
| `--json` | Báo cáo dạng JSON ra stdout |
| `-q, --quiet` | Chỉ in lỗi |
| `-h, --help` | Trợ giúp |
| `-v, --version` | Phiên bản |

### Mã thoát

| Mã | Ý nghĩa |
|---|---|
| `0` | Mọi rule chuyển và kiểm tra thành công |
| `1` | Có ít nhất một rule lỗi |
| `2` | Dùng sai cú pháp |

Nhờ mã thoát, có thể dùng làm cổng chặn trong CI: bộ rule nào import vào Kibana sẽ lỗi thì build fail luôn.

### An toàn theo mặc định

- **Không ghi đè im lặng.** Nếu file output đã tồn tại, rulepress từ chối và liệt kê những gì nó định ghi đè.
  Thêm `--force` khi thật sự muốn.
- **`--dry-run` không ghi gì cả** — kể cả không tạo thư mục rỗng.
- **`--init` không ghi đè config đã có** nếu không có `--force`.
- **Gõ sai được gợi ý.** `--dry-runn` sẽ báo "Did you mean `--dry-run`?", và đường dẫn sai sẽ in ra đường dẫn
  tuyệt đối đã kiểm tra kèm thư mục có lẽ bạn muốn dùng.

### Cấu hình theo project

`rulepress --init` tạo file `rulepress.config.json`:

```json
{
  "out": "ndjson",
  "bundle": null,
  "strict": false,
  "quiet": false,
  "skip": ["node_modules", ".git", "dist", "build"]
}
```

Giá trị trong file là mặc định; tham số trên dòng lệnh luôn được ưu tiên.

## Vì sao không chỉ chuyển TOML sang JSON

Chuyển thẳng sẽ tạo ra file Kibana từ chối hoặc hiểu sai. Ba chỗ vỡ:

| Trong TOML | Kibana cần | Chuyển thô làm gì |
|---|---|---|
| `[rule.new_terms]` với `field` / `value` | key cấp cao **đặt tên theo** `field` | hard-code `new_terms_fields`, hỏng mọi rule đổi tên |
| `$investigate_0` trong `note` | chuỗi plugin `!{investigate{...}}` | để nguyên `$investigate_0` trong alert |
| `[rule.threshold]` với `field` dạng chuỗi | mảng | truyền nguyên chuỗi |
| bảng `[metadata]` / `[transform]` | không có — chỉ dùng trong repo | nhét luôn vào payload |
| BOM UTF-8 do editor trên Windows thêm vào | không BOM | parser TOML crash |

`rulepress` xử lý tất cả, cộng thêm rule ES|QL, building block, và `[[rule.filters]]` (tự điền `$state.store`
thành `appState` khi thiếu, đúng như Kibana UI ghi).

## Những gì bị bỏ qua

`elastic/detection-rules` dùng `.toml` cho ba loại khác nhau. Chỉ loại đầu là rule Kibana:

- `[rule]` — detection rule. Được chuyển.
- `[hunt]` — hunting query (`hunting/**`). Schema khác, Kibana không import được. Bỏ qua, báo là `skip`.
- không phải hai loại trên — config build như `pyproject.toml`. Bỏ qua.

Bỏ qua không tính là lỗi, nên chạy toàn repo vẫn xanh.

## Kiểm tra

Mỗi rule sau khi chuyển được kiểm tra những thứ Kibana chỉ báo bằng một lỗi 400 chung chung:

- các field bắt buộc (`name`, `rule_id`, `type`, `severity`, `risk_score`)
- `rule_id` là UUID thật
- `language` khớp `type` (`eql`/`eql`, `esql`/`esql`, `kuery` hoặc `lucene` cho phần còn lại)
- có `index` ở nơi type cần (ES|QL thì không)
- có `new_terms_fields` với rule `new_terms`
- có `threshold.value` với rule `threshold`
- không còn field chỉ dùng trong repo (`metadata`, `transform`, `new_terms`, `meta`)
- mọi filter đều có `$state.store` (tự điền, và cảnh báo nếu thiếu)
- không còn `$osquery_N` / `$investigate_N` chưa render trong `note`

## Chạy được trên cả ba hệ điều hành

rulepress chạy trên Windows, Linux và macOS. Điều này được kiểm chứng chứ không phải chỉ nói:

- **CI chạy toàn bộ test trên cả ba hệ điều hành**, với Node 18, 20 và 22
  ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).
- **CI chạy chuyển đổi thật từ đầu đến cuối** và kiểm tra từng dòng NDJSON, không chỉ unit test.
- **CI fail nếu có file source chứa CRLF.** Shebang CRLF (`#!/usr/bin/env node\r`) làm CLI chết trên Linux với
  lỗi `bad interpreter: No such file or directory`. [`.gitattributes`](.gitattributes) ép LF cho source và chỉ
  CRLF cho `.ps1` / `.cmd` / `.bat`.
- **Xử lý đường dẫn dùng `node:path`** xuyên suốt, nên cả backslash của Windows và slash của POSIX đều đúng.
- **`--open` chọn đúng lệnh theo hệ điều hành**: `explorer` trên Windows, `open` trên macOS, `xdg-open` trên Linux.

## Dùng như thư viện

```js
import { convertToml, validateRule, toNdjsonLine } from 'rulepress';
import fs from 'node:fs';

const { kind, rule, warnings } = convertToml(fs.readFileSync('rule.toml', 'utf8'), { source: 'rule.toml' });
if (kind !== 'rule') throw new Error(`không phải detection rule: ${kind}`);

const { errors } = validateRule(rule, { source: 'rule.toml' });
if (errors.length) throw new Error(errors.join('\n'));

fs.writeFileSync('rule.ndjson', toNdjsonLine(rule) + '\n');
```

## Đã kiểm chứng trên repo thật

Chạy trên toàn bộ 2.629 file TOML trong `elastic/detection-rules@main`:

```
2482 converted, 2 failed, 146 skipped
```

Hai lỗi là defect thật của repo đó, không phải lỗi converter — cả hai `rule_id` đều dài 37 ký tự:

- `rules/_deprecated/exfiltration_rds_snapshot_export.toml` → `119c8877-8613-416d-a98a-96b6664ee73a5`
- `rules/windows/defense_evasion_modify_ownership_os_files.toml` → `7eb54028-ca72-4eb7-8185-b6864572347db`

Kibana cũng sẽ từ chối cả hai. `rulepress` bắt được trước khi import.

## Import vào Kibana

1. `rulepress rules/ --bundle rules.ndjson`
2. Kibana → **Security** → **Detection rules (SIEM)** → **Import rules**
3. Chọn file `rules.ndjson`

Với bộ rule lớn, nên import theo từng thư mục (`rules/windows/`, `rules/linux/`, …) để một rule lỗi không chặn
toàn bộ phần còn lại.

## Phát triển

```bash
npm install
npm test          # 61 test
npm run lint      # kiểm tra cú pháp
```

## Giấy phép

MIT
