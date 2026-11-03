#!/bin/bash
# arm64（QEMU 模拟）可执行性验证 —— 在 **linux/arm64 容器内**运行：
#
#   docker run --rm --platform linux/arm64 -v C:\mimo-gui:/work -w /work \
#     ubuntu:24.04 bash /work/android-shell/verify-arm64.sh
#
# 验证范围（都是真实 arm64 指令，QEMU 翻译执行）：
#   1. 安装包里的 arm64 Node 能启动；
#   2. 安装包里的 arm64 codem-db + Host 能完成 hello / session.create / session.list；
#   3. 交叉编译的 Linux arm64 codem-db 能跑。
#
# **不验证**（需要 Android arm64 真机）：PRoot（Android bionic 链接，容器里无 /system/bin/linker64）、
# WebView、Android 沙箱/exec 策略。
set -u
NODE=/work/.android-proot/node-arm64-extract/node-v22.14.0-linux-arm64/bin/node
export LD_LIBRARY_PATH=/work/.android-proot/arm64
FAIL=0

echo "== arm64 node =="
if "$NODE" -v; then echo "NODE_OK"; else echo "NODE_FAIL"; FAIL=1; fi

DB_ANDROID=/work/android-shell/build/arm64/stage/lib/arm64-v8a/libcodem_db.so
if [ -f "$DB_ANDROID" ]; then
  cp "$DB_ANDROID" /tmp/codem-db-android && chmod +x /tmp/codem-db-android
  echo "== arm64 codem-db (from APK) =="
  if /tmp/codem-db-android --help >/dev/null 2>&1; then echo "APKDB_OK"; else echo "APKDB_FAIL"; FAIL=1; fi
else
  echo "APKDB_MISSING（先 npm run android:build:arm64）"
  FAIL=1
fi

DB_LINUX=/work/.linux-target/aarch64-unknown-linux-gnu/release/codem-db-cli
if [ -f "$DB_LINUX" ]; then
  cp "$DB_LINUX" /tmp/codem-db-linux && chmod +x /tmp/codem-db-linux
  echo "== linux arm64 codem-db =="
  if /tmp/codem-db-linux --help >/dev/null 2>&1; then echo "LINUXDB_OK"; else echo "LINUXDB_FAIL"; FAIL=1; fi
fi

run_host() {
  local db="$1" port="$2" tag="$3"
  rm -rf "/tmp/data-$tag" "/tmp/ws-$tag"; mkdir -p "/tmp/data-$tag" "/tmp/ws-$tag"
  CODEM_DB_BIN="$db" "$NODE" /work/packages/host/dist/host.mjs serve \
    --data-home "/tmp/data-$tag" --workspace "/tmp/ws-$tag" \
    --web /work/packages/host/web --port "$port" >"/tmp/host-$tag.log" 2>&1 &
  local pid=$!
  for _ in $(seq 1 90); do sleep 1; grep -q '"ready":true' "/tmp/host-$tag.log" && break; done
  "$NODE" -e '
    const b="http://127.0.0.1:'"$port"'/rpc";
    const call=(m,p)=>fetch(b,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:m,params:p})}).then(r=>r.json());
    (async()=>{const h=await call("host.hello",{protocolVersion:1,client:{name:"arm64",version:"0",platform:"node"}});
      const s=await call("session.create",{title:"arm64"});
      const l=await call("session.list",{});
      console.log("HOST_OK hostId="+h.result?.hostId+" session="+s.result?.session?.id+" count="+(l.result?.items||[]).length);
    })().catch(e=>{console.error("HOST_FAIL",e?.message??e);process.exit(1)})' || FAIL=1
  kill "$pid" 2>/dev/null || true
}

if [ -x /tmp/codem-db-android ]; then
  echo "== host + APK arm64 db =="
  run_host /tmp/codem-db-android 8791 apkdb || FAIL=1
fi
if [ -x /tmp/codem-db-linux ]; then
  echo "== host + linux arm64 db =="
  run_host /tmp/codem-db-linux 8792 linuxdb || FAIL=1
fi

echo "ARM64_QEMU_RESULT=$([ "$FAIL" = 0 ] && echo PASS || echo FAIL)"
exit "$FAIL"
