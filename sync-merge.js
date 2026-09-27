// 多裝置雲端同步：三方合併＋版本比對（compare-and-swap）。
// 不依賴各裝置的時鐘：以雲端 updated_at（伺服器時間）當版本號，
// 本機記住「上次同步時的內容」當共同基準，逐項合併兩邊各自的修改。
(function (root) {
  "use strict";

  const META_KEY = "_syncMeta";
  const BLANK_KEY = "_blankDefault";
  const MAX_KEYS = new Set(["_nextNoteOrder"]);
  const MAX_ATTEMPTS = 4;

  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function deepEqual(a, b) {
    if (a === b) return true;
    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i += 1) if (!deepEqual(a[i], b[i])) return false;
      return true;
    }
    if (isPlainObject(a)) {
      if (!isPlainObject(b)) return false;
      const keys = Object.keys(a);
      if (keys.length !== Object.keys(b).length) return false;
      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(b, key) || !deepEqual(a[key], b[key])) return false;
      }
      return true;
    }
    return false;
  }
  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }
  function stripMeta(data) {
    const out = isPlainObject(data) ? { ...data } : {};
    delete out[META_KEY];
    return out;
  }
  function isBlank(data) {
    return !isPlainObject(data) || data[BLANK_KEY] === true || Object.keys(stripMeta(data)).length === 0;
  }

  // 陣列元素的身分：任務用 id；今日任務用 學期|考試|科目|taskId|來源。其他陣列整個當成一個值。
  function itemKey(item) {
    if (!isPlainObject(item)) return null;
    if (item.id !== undefined && item.id !== null) return "id:" + item.id;
    if (item.taskId !== undefined && item.taskId !== null) {
      return ["t", item.term, item.exam, item.subject, item.taskId, item.source]
        .map((part) => (part === undefined || part === null ? "" : String(part)))
        .join("|");
    }
    return null;
  }
  function keyedMap(list) {
    if (!Array.isArray(list)) return null;
    const map = new Map();
    for (const item of list) {
      const key = itemKey(item);
      if (key === null || map.has(key)) return null;
      map.set(key, item);
    }
    return map;
  }

  function mergeKeyedArray(base, local, remote, ctx, path) {
    const localMap = keyedMap(local);
    const remoteMap = keyedMap(remote);
    if (!localMap || !remoteMap) return null;
    const baseMap = keyedMap(Array.isArray(base) ? base : []) || new Map();
    const merged = new Map();
    for (const key of new Set([...localMap.keys(), ...remoteMap.keys()])) {
      const value = merge3(baseMap.get(key), localMap.get(key), remoteMap.get(key), ctx, path.concat(key));
      if (value !== undefined) merged.set(key, value);
    }
    // 順序：哪一邊調過順序就用哪一邊的（都調過用本機的），另一邊新增的項目插在它原本前一項的後面
    const baseOrder = Array.isArray(base) && baseMap.size ? base.map(itemKey) : [];
    const orderChanged = (order) => {
      const common = order.filter((key) => baseMap.has(key));
      return !deepEqual(common, baseOrder.filter((key) => common.includes(key)));
    };
    const localOrder = local.map(itemKey);
    const remoteOrder = remote.map(itemKey);
    const useLocal = orderChanged(localOrder) || !orderChanged(remoteOrder);
    const primary = useLocal ? localOrder : remoteOrder;
    const secondary = useLocal ? remoteOrder : localOrder;
    const sequence = primary.filter((key) => merged.has(key));
    secondary.forEach((key, index) => {
      if (!merged.has(key) || sequence.includes(key)) return;
      let position = 0;
      for (let j = index - 1; j >= 0; j -= 1) {
        const found = sequence.indexOf(secondary[j]);
        if (found >= 0) { position = found + 1; break; }
      }
      sequence.splice(position, 0, key);
    });
    return sequence.map((key) => merged.get(key));
  }

  // 三方合併：只改了一邊就用那一邊；兩邊都改了同一個欄位才算衝突（以本機為準，
  // 但「一邊刪除、一邊修改」時保留修改過的那份，避免資料消失）。
  function merge3(base, local, remote, ctx, path) {
    if (deepEqual(local, remote)) return clone(local);
    if (deepEqual(local, base)) return clone(remote);
    if (deepEqual(remote, base)) return clone(local);
    const last = path[path.length - 1];
    if (MAX_KEYS.has(last) && typeof local === "number" && typeof remote === "number") return Math.max(local, remote);
    if (isPlainObject(local) && isPlainObject(remote)) {
      const baseObject = isPlainObject(base) ? base : {};
      const out = {};
      for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
        const value = merge3(baseObject[key], local[key], remote[key], ctx, path.concat(key));
        if (value !== undefined) out[key] = value;
      }
      return out;
    }
    if (Array.isArray(local) && Array.isArray(remote)) {
      const merged = mergeKeyedArray(base, local, remote, ctx, path);
      if (merged) return merged;
    }
    ctx.conflicts.push(path.join(" › ") || "(整份資料)");
    return local === undefined ? clone(remote) : clone(local);
  }

  function mergeStates(base, local, remote) {
    const ctx = { conflicts: [] };
    const data = merge3(stripMeta(base), stripMeta(local), stripMeta(remote), ctx, []);
    return { data, conflicts: ctx.conflicts };
  }

  function syncTime(data) {
    const time = Date.parse((isPlainObject(data) && isPlainObject(data[META_KEY]) && data[META_KEY].updatedAt) || "");
    return Number.isFinite(time) ? time : 0;
  }

  /**
   * 跟雲端同步一次。io 由呼叫端提供：
   *   getLocal() → 目前本機資料（含 _syncMeta）
   *   getBase() → { data, version } 或 null（上次同步的內容與雲端版本）
   *   setBase(data, version)
   *   applyLocal(data) → 用合併結果取代本機資料
   *   fetchRemote() → { data, updated_at } 或 null
   *   insertRemote(data) → { ok, version, conflict }
   *   updateRemote(data, expectedVersion) → { ok, version }（版本不符時 ok=false）
   *   backup(data, reason)
   *   makeMeta() → 這次上傳要寫入的 _syncMeta
   * 回傳 { action: "none"|"pushed"|"pulled"|"merged", conflicts: [...] }
   */
  async function syncWithCloud(io) {
    const withMeta = (data) => ({ ...data, [META_KEY]: io.makeMeta() });
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const remote = await io.fetchRemote();
      const localFull = io.getLocal();
      const local = stripMeta(localFull);
      const base = io.getBase();

      if (!remote || !remote.data) {
        const result = await io.insertRemote(withMeta(local));
        if (!result.ok) { if (result.conflict) continue; throw new Error("雲端寫入失敗"); }
        io.setBase(local, result.version);
        return { action: "pushed", conflicts: [] };
      }

      const remoteData = stripMeta(remote.data);
      if (base && base.version && base.version === remote.updated_at) {
        if (deepEqual(local, base.data)) return { action: "none", conflicts: [] };
        const result = await io.updateRemote(withMeta(local), remote.updated_at);
        if (!result.ok) continue;
        io.setBase(local, result.version);
        return { action: "pushed", conflicts: [] };
      }

      let merged;
      let conflicts = [];
      if (base) {
        ({ data: merged, conflicts } = mergeStates(base.data, local, remoteData));
      } else if (isBlank(localFull) || deepEqual(local, remoteData)) {
        merged = remoteData;
      } else {
        // 這台裝置第一次同步、沒有共同基準：整份較新的勝出，另一份存進雲端備份
        const localNewer = syncTime(localFull) > syncTime(remote.data);
        merged = localNewer ? local : remoteData;
        conflicts = ["(首次同步：整份採用" + (localNewer ? "這台裝置" : "雲端") + "的資料)"];
        if (!localNewer) await io.backup(localFull, "首次同步前的本機資料");
      }
      if (conflicts.length && !deepEqual(merged, remoteData)) await io.backup(remote.data, "合併前的雲端資料");

      // 等待網路期間使用者若又改了東西，把那些修改疊在合併結果上
      const current = stripMeta(io.getLocal());
      const toApply = deepEqual(current, local) ? merged : mergeStates(local, current, merged).data;
      if (!deepEqual(toApply, current)) io.applyLocal(toApply);

      if (deepEqual(merged, remoteData)) {
        io.setBase(merged, remote.updated_at);
        return { action: "pulled", conflicts };
      }
      const result = await io.updateRemote(withMeta(merged), remote.updated_at);
      if (!result.ok) continue;
      io.setBase(merged, result.version);
      return { action: "merged", conflicts };
    }
    throw new Error("雲端資料一直在變動，請稍後再試");
  }

  const api = { deepEqual, stripMeta, isBlank, merge3, mergeStates, syncWithCloud };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ReviewSync = api;
})(typeof window !== "undefined" ? window : globalThis);
