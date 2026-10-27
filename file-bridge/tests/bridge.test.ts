import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { Bridge, quoteUnix, reconcileOwner } from "../server/bridge.ts";
import { preferences } from "../shared/contracts.ts";

test("SSH shell arguments preserve apostrophes and reject unsafe connection settings", () => {
  assert.equal(quoteUnix("a'b"), "'a'\"'\"'b'");
  assert.throws(() => preferences.schema.parse({sshHost:"node030;id"}));
  assert.throws(() => preferences.schema.parse({sshHost:"node030\n"}));
  assert.throws(() => preferences.schema.parse({sshHost:"-Fbad@node030"}));
  assert.throws(() => preferences.schema.parse({remoteScript:"/tmp/../other.py"}));
});

test("existing same-device sessions remain usable without claiming process ownership", () => {
  const owner = { worker_connected:true, device_id:"a".repeat(32), device_name:"KL-BOSC", session_id:"b".repeat(32) };
  assert.deepEqual(reconcileOwner("win32", owner.device_id, "new-session", false, "error", owner), { state:"connected", ownership:"same-device" });
  assert.deepEqual(reconcileOwner("win32", owner.device_id, owner.session_id, true, "connected", owner), { state:"connected", ownership:"managed" });
  assert.deepEqual(reconcileOwner("win32", owner.device_id, owner.session_id, true, "connected", {worker_connected:false}), { state:"connecting", ownership:"managed" });
  assert.deepEqual(reconcileOwner("win32", "different-device", "new-session", false, "error", owner), { state:"error", ownership:"none" });
  assert.deepEqual(reconcileOwner("linux", owner.device_id, "", false, "stopped", owner), { state:"stopped", ownership:"none" });
});

test("repeat acquisition reuses same-device owner and keeps queue requests fenced", async () => {
  const root = await mkdtemp(join(tmpdir(), "file-bridge-owner-"));
  const oldHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = root;
  const bridge = new Bridge(async () => preferences.schema.parse({}));
  const first = await bridge.status();
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const owner = { worker_connected:true, device_id:first.deviceId, device_name:"KL-BOSC", session_id:"b".repeat(32) };
  const commands: string[][] = [];
  const target = bridge as unknown as { command(args: string[]): Promise<unknown> };
  const patched = mock.method(target, "command", async (args: string[]) => {
    commands.push(args);
    if (args[0] === "worker-status") return owner;
    if (args[0] === "list") return { jobs:[] };
    return {id:"c".repeat(32), action:"push", state:"pending", filename:"input.txt"};
  });
  try {
    Object.defineProperty(process, "platform", {...platform,value:"win32"});
    await bridge.start(); await bridge.start();
    assert.deepEqual(commands, [["worker-status"], ["worker-status"]]);
    const status = await bridge.status();
    assert.equal(status.state, "connected"); assert.equal(status.ownership, "same-device");
    assert.equal(status.error, null); assert.match(status.notice!, /另一插件实例/);
    await bridge.queue({action:"push", source:"/input.txt", confirmed:false});
    assert.deepEqual(commands.at(-1), ["queue-push","/input.txt","--expected-device",owner.device_id,"--expected-session",owner.session_id]);
    owner.device_id = "d".repeat(32);
    await assert.rejects(() => bridge.start(), /控制权由/);
    await assert.rejects(() => bridge.queue({action:"push",source:"/input.txt",confirmed:false}), /未取得控制权/);
  } finally {
    Object.defineProperty(process, "platform", platform);patched.mock.restore();await bridge.stop();
    if (oldHome===undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME=oldHome;
    await rm(root,{recursive:true,force:true});
  }
});

test("Bridge RPC service and actual Python worker agree on status, push and pull", async () => {
  const root = await mkdtemp(join(tmpdir(), "file-bridge-"));
  const oldHome = process.env.PASEO_HOME; const oldState = process.env.PASEO_FILE_BRIDGE_STATE;
  process.env.PASEO_HOME = join(root, "paseo"); process.env.PASEO_FILE_BRIDGE_STATE = join(root, "queue");
  const bridge = new Bridge(async () => preferences.schema.parse({}));
  const worker = spawn("python3", ["-u", "server/desktop_transfer.py", "worker", "--device-id", "a".repeat(32), "--device-name", "TEST-WINDOWS", "--session-id", "b".repeat(32)], {stdio:["pipe","pipe","pipe"]});
  const lines = createInterface({input:worker.stdout});
  const received: object[] = [];
  lines.on("line", line => {
    const message = JSON.parse(line); received.push(message);
    if (message.action === "push") worker.stdin.write(JSON.stringify({id:message.id,ok:true,staged:true,stage_path:"C:\\Temp\\file-bridge\\sample.txt",size:message.size,sha256:message.sha256}) + "\n");
    if (message.action === "pull") {
      assert.equal(message.windows_source, "C:\\Users\\test\\result.txt");
      const data=Buffer.from("return bytes");
      worker.stdin.write(JSON.stringify({id:message.id,ok:true,data_base64:data.toString("base64"),size:data.length,sha256:createHash("sha256").update(data).digest("hex")})+"\n");
    }
  });
  const until = async (check: () => Promise<boolean>) => { const deadline=Date.now()+4000; while (!await check()) {if(Date.now()>deadline)throw Error("worker timeout");await new Promise(r=>setTimeout(r,40));} };
  try {
    await until(async () => (await bridge.status()).coordinator?.worker_connected === true);
    const input = join(root, "sample.txt"); await writeFile(input, "test bytes");
    const push = await bridge.queue({action:"push",source:input,confirmed:false});
    await until(async () => (await bridge.job(push.id)).state === "completed");
    assert.equal((await bridge.status()).jobs[0].id,push.id);
    assert.equal((await bridge.job(push.id)).size,10);
    const result = join(root,"result.txt");
    const pull = await bridge.queue({action:"pull",source:"C:\\Users\\test\\result.txt",filename:"result.txt",destination:result,confirmed:false});
    await until(async () => (await bridge.job(pull.id)).state !== "pending" && (await bridge.job(pull.id)).state !== "running");
    assert.equal((await bridge.job(pull.id)).state,"completed",JSON.stringify(await bridge.job(pull.id)));
    assert.equal(await readFile(result,"utf8"),"return bytes");
    assert.ok(received.length>=5);
  } finally {
    const closed=once(worker,"close");worker.stdin.end();await closed;lines.close();await bridge.stop();
    if(oldHome===undefined)delete process.env.PASEO_HOME;else process.env.PASEO_HOME=oldHome;
    if(oldState===undefined)delete process.env.PASEO_FILE_BRIDGE_STATE;else process.env.PASEO_FILE_BRIDGE_STATE=oldState;
    await rm(root,{recursive:true,force:true});
  }
});
