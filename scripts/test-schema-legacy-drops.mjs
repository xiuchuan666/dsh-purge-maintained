/**
 * lib/redteam/schema.js 的「删老列」与「读不到表结构」两条边角。
 *
 * 老库里有三列是上一版留下的：`stage.attck`、`stage.blue_team`、
 * `score_point.stage_code`。新版按 code/名称推导阶段，不再用它们，`migrate()`
 * 负责删掉。删不掉（老 SQLite 不支持 `DROP COLUMN`）只能保留 —— 但绝不能因此
 * 抛错，否则整个库打不开。
 *
 * 另一条：`has()` 读 `PRAGMA table_info` 失败时必须返回 false（= 「没有这一列」），
 * 让后面的 `ensure` 去尝试 ALTER；返回 true 会让迁移静默跳过，代码随后按新列写
 * SQL，故障表现成远端 SQL 报错而不是迁移失败。
 *
 * 与 test-schema-migrate.mjs（23 条）分工：那一份钉回填与可重复执行，
 * 这一份只钉删列的三条路径与 `has()` 的 catch。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { DDL, migrate } from "../lib/redteam/schema.js";

const SRC = readFileSync(new URL("../lib/redteam/schema.js", import.meta.url), "utf8");

const fresh = () => {
  const db = new DatabaseSync(":memory:");
  db.exec(DDL);
  return db;
};

const columns = (db, table) =>
  db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name);

const LEGACY = {
  stage: ["attck", "blue_team"],
  scorePoint: "stage_code",
};

const legacyPresent = (db) => ({
  stage: columns(db, "stage").filter((name) => LEGACY.stage.includes(name)).sort(),
  scorePoint: columns(db, "score_point").includes(LEGACY.scorePoint),
});

const addLegacy = (db, which) => {
  if (which.includes("attck")) db.exec("ALTER TABLE stage ADD COLUMN attck TEXT");
  if (which.includes("blue_team")) db.exec("ALTER TABLE stage ADD COLUMN blue_team INTEGER");
  if (which.includes("score_point")) db.exec("ALTER TABLE score_point ADD COLUMN stage_code TEXT");
};

test("三列老字段一次全删：migrate 之后 stage.attck / stage.blue_team / score_point.stage_code 都不在", () => {
  const db = fresh();
  addLegacy(db, ["attck", "blue_team", "score_point"]);
  assert.deepEqual(legacyPresent(db), { stage: ["attck", "blue_team"], scorePoint: true });
  migrate(db);
  assert.deepEqual(legacyPresent(db), { stage: [], scorePoint: false });
  db.close();
});

test("只带一列时也只删那一列，且不因此多出别的列", () => {
  const db = fresh();
  addLegacy(db, ["attck"]);
  migrate(db);
  assert.equal(columns(db, "stage").includes("attck"), false);
  assert.equal(columns(db, "score_point").includes("stage_code"), false);
  db.close();
});

test("删列失败时保留列且不抛（老 SQLite 不支持 DROP COLUMN 的机器）", () => {
  const db = fresh();
  addLegacy(db, ["attck", "blue_team"]);
  const wrapped = {
    prepare: (sql) => db.prepare(sql),
    exec: (sql) => {
      if (/DROP COLUMN/i.test(sql)) throw new Error("no drop column");
      return db.exec(sql);
    },
  };
  assert.doesNotThrow(() => migrate(wrapped));
  assert.deepEqual(legacyPresent(db), { stage: ["attck", "blue_team"], scorePoint: false });
  db.close();
});

test("读不到表结构时 has() 回 false（迁移静默跳过），整段不抛、老列原样留着", () => {
  const db = fresh();
  addLegacy(db, ["attck", "blue_team", "score_point"]);
  const blind = {
    prepare: (sql) => {
      if (sql.startsWith("PRAGMA table_info")) throw new Error("pragma boom");
      return db.prepare(sql);
    },
    exec: (sql) => db.exec(sql),
  };
  assert.doesNotThrow(() => migrate(blind));
  assert.deepEqual(legacyPresent(db), { stage: ["attck", "blue_team"], scorePoint: true });
  db.close();
});

test("PRAGMA 读不到 + 表根本不存在时也不抛（首次建库前误调）", () => {
  const db = new DatabaseSync(":memory:");
  const blind = {
    prepare: (sql) => {
      if (sql.startsWith("PRAGMA table_info")) throw new Error("pragma boom");
      return db.prepare(sql);
    },
    exec: (sql) => db.exec(sql),
  };
  assert.doesNotThrow(() => migrate(blind));
  db.close();
});

test("只对某张表读不到结构时，那张表仍会被补列（has 回 false 才会去 ALTER）", () => {
  const db = fresh();
  db.exec("ALTER TABLE asset DROP COLUMN test_notes");
  assert.equal(columns(db, "asset").includes("test_notes"), false);
  const wrapped = {
    prepare: (sql) => {
      if (sql.includes("table_info(asset)")) throw new Error("pragma boom");
      return db.prepare(sql);
    },
    exec: (sql) => db.exec(sql),
  };
  migrate(wrapped);
  assert.equal(columns(db, "asset").includes("test_notes"), true);
  db.close();
});

test("删列是幂等的：连跑两次结果一致", () => {
  const db = fresh();
  addLegacy(db, ["attck", "blue_team", "score_point"]);
  migrate(db);
  const first = legacyPresent(db);
  assert.doesNotThrow(() => migrate(db));
  assert.deepEqual(legacyPresent(db), first);
  db.close();
});

test("源码形状：三处 DROP COLUMN 都包在 try/catch 里，catch 只写注释不抛", () => {
  const lines = SRC.split(/\r?\n/);
  const dropLines = lines
    .map((line, index) => ({ line, no: index + 1 }))
    .filter((it) => /ALTER TABLE \w+ DROP COLUMN/.test(it.line));
  assert.equal(dropLines.length, 3);
  for (const { line, no } of dropLines) {
    assert.match(line, /^ {4}try \{ db\.exec\('ALTER TABLE \w+ DROP COLUMN \w+'\) \} catch \{/);
    assert.match(line, /catch \{ \/\*.*\*\/ \}$/);
    assert.equal(typeof no, "number");
  }
  assert.doesNotMatch(SRC, /throw new Error\('drop/);
});

test("源码形状：has() 的 catch 必须 return false（不是 true）", () => {
  assert.match(
    SRC,
    /} catch \{\r?\n {6}\/\* 读不到表结构必须返回 false/,
  );
  assert.match(SRC, /不是迁移失败。 \*\/\r?\n {6}return false\r?\n {4}\}/);
});
