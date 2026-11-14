# rulepress

Chuyển rule Elastic từ TOML sang NDJSON để import thẳng vào Kibana.

Repo [elastic/detection-rules](https://github.com/elastic/detection-rules) lưu rule dạng TOML, nhưng
**Detection rules → Import** của Kibana chỉ nhận NDJSON. `rulepress` làm phần chuyển đổi đó, và khác với việc
`toml → json` thô, nó áp đúng cách Elastic build lại payload trước khi gửi Kibana, nên rule import được thật.

## Vì sao không chỉ convert TOML sang JSON

Convert thẳng sẽ ra file Kibana từ chối hoặc làm sai nội dung. Ba chỗ hỏng:

| Trong TOML | Kibana cần | Convert thô làm gì |
|---|---|---|
| `[rule.new_terms]` với `field` / `value` | key top-level **đặt tên theo** `field` | hard-code `new_terms_fields`, hỏng mọi rule đổi tên field |
| `$investigate_0` trong `note` | chuỗi plugin `!{investigate{...}}` | để nguyên `$investigate_0` trong alert |
| `[rule.threshold]` với `field` là chuỗi trần | mảng | truyền nguyên chuỗi |
| bảng `[metadata]` / `[transform]` | không cần, chỉ có trong repo | nhét luôn vào payload |
| BOM UTF-8 do editor Windows thêm vào | không có BOM | làm parser TOML chết |

`rulepress` xử lý tất cả, cộng thêm rule ES|QL, building block, và `[[rule.filters]]` (tự điền
`$state.store = appState` khi thiếu, đúng như Kibana UI ghi).

## Cài đặt

```bash
npm install -g rulepress
```

Hoặc chạy trực tiếp từ bản clone, không cần cài global:

```bash
git clone https://github.com/TuanCui22/rulepress.git
cd rulepress
npm install
node bin/rulepress.js --help
```

Cần Node 18 trở lên.

## Cách dùng

```bash
rulepress <input...> [options]
```

`<input>` là một hoặc nhiều file `.toml`, hoặc thư mục (quét đệ quy).

```bash
# mỗi rule một file, ghi vào ./ndjson
rulepress rules/

# chỉ lấy một nhóm
rulepress rules/windows/defense_evasion_*.toml -o build/

# gộp một file để import một lần
rulepress rules/ --bundle rules.ndjson

# CI: chỉ convert và validate, không ghi file, fail nếu có warning
rulepress rules/ --check --strict
```

### Tuỳ chọn

| Tuỳ chọn | Ý nghĩa |
|---|---|
| `-o, --out <dir>` | Thư mục output (mặc định `./ndjson`) |
| `--bundle <file>` | Gộp tất cả rule vào một file NDJSON |
| `--check` | Chỉ convert và validate, không ghi file |
| `--strict` | Coi warning là lỗi (nên bật trong CI) |
| `--json` | Báo cáo dạng JSON ra stdout |
| `-q, --quiet` | Chỉ in lỗi |
| `-h, --help` | Trợ giúp |
| `-v, --version` | Phiên bản |

### Mã thoát

| Mã | Ý nghĩa |
|---|---|
| `0` | Tất cả rule convert và hợp lệ |
| `1` | Có ít nhất một rule lỗi |
| `2` | Dùng sai cú pháp |

Mã thoát dùng được làm cổng CI: rule pack nào sẽ lỗi lúc import thì fail ở build luôn.

## Những gì bị bỏ qua

`elastic/detection-rules` dùng `.toml` cho ba loại khác nhau. Chỉ loại đầu là rule Kibana:

- `[rule]` — detection rule. Được convert.
- `[hunt]` — hunting query (`hunting/**`). Schema khác, Kibana không import được. Bỏ qua, báo `skip`.
- không có bảng nào — file cấu hình build như `pyproject.toml`. Bỏ qua.

Bỏ qua không tính là lỗi, nên chạy cả repo vẫn xanh.

## Kiểm tra hợp lệ

Mỗi rule sau khi convert được soát những lỗi mà Kibana chỉ trả về một câu 400 chung chung:

- các field bắt buộc (`name`, `rule_id`, `type`, `severity`, `risk_score`)
- `rule_id` đúng định dạng UUID
- `language` khớp `type` (`eql`/`eql`, `esql`/`esql`, `kuery` hoặc `lucene` cho phần còn lại)
- có `index` ở những type cần (ES|QL thì không)
- có `new_terms_fields` với type `new_terms`
- có `threshold.value` với type `threshold`
- không sót field chỉ có trong repo (`metadata`, `transform`, `new_terms`, `meta`)
- mọi filter đều có `$state.store` (tự điền, và cảnh báo nếu thiếu)
- không còn `$osquery_N` / `$investigate_N` chưa render trong `note`

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

## Đã test trên repo thật

Chạy trên toàn bộ 2.629 file TOML của `elastic/detection-rules@main`:

```
2482 converted, 2 failed, 146 skipped
```

2 lỗi là khiếm khuyết thật của repo đó, không phải lỗi converter — cả hai `rule_id` đều dài 37 ký tự:

- `rules/_deprecated/exfiltration_rds_snapshot_export.toml` → `119c8877-8613-416d-a98a-96b6664ee73a5`
- `rules/windows/defense_evasion_modify_ownership_os_files.toml` → `7eb54028-ca72-4eb7-8185-b6864572347db`

Kibana cũng sẽ từ chối cả hai. `rulepress` bắt được trước khi import.

## Import vào Kibana

1. `rulepress rules/ --bundle rules.ndjson`
2. Kibana → **Security → Detection rules → Import**
3. Upload `rules.ndjson`

Với pack lớn, nên import theo từng thư mục (`rules/windows/`, `rules/linux/`, …) để một rule lỗi không chặn
phần còn lại.

## Giấy phép

MIT
