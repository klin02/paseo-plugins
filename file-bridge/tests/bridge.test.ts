import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { Bridge, quoteUnix } from "../server/bridge.ts";
import { preferences } from "../shared/contracts.ts";

test("SSH shell arguments preserve apostrophes and reject unsafe connection settings", () => {
  assert.equal(quoteUnix("a'b"), "'a'\"'\"'b'");
  assert.throws(() => preferences.schema.parse({sshHost:"node030;id"}));
  assert.throws(() => preferences.schema.parse({sshHost:"node030\n"}));
  assert.throws(() => preferences.schema.parse({sshHost:"-Fbad@node030"}));
  assert.throws(() => preferences.schema.parse({remoteScript:"/tmp/../other.py"}));
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
