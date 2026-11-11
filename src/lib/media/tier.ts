// Device tier by detected capability, not browser name (spec §2.2).
export type Tier = "full" | "standard" | "lite";

export interface Capabilities {
  tier: Tier; webgpu: boolean; webgl2: boolean; webcodecs: boolean; opfs: boolean; isolated: boolean;
  fsAccess: boolean; mobile: boolean; threads: number; memory: number; wakeLock: boolean;
}

export async function detect(): Promise<Capabilities> {
  const nav = navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> }; deviceMemory?: number; userAgentData?: { mobile?: boolean } };
  let webgpu = false;
  try { webgpu = !!nav.gpu && !!(await nav.gpu.requestAdapter()); } catch { webgpu = false; }
  let webgl2 = false;
  try { webgl2 = !!document.createElement("canvas").getContext("webgl2"); } catch { webgl2 = false; }
  const webcodecs = typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";
  let opfs = false;
  try { opfs = !!(await navigator.storage?.getDirectory?.()); } catch { opfs = false; }
  const mobile = nav.userAgentData?.mobile ?? (/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 900));
  const threads = navigator.hardwareConcurrency || 2;
  const memory = nav.deviceMemory ?? 4;
  const tier: Tier = mobile || memory < 4 ? "lite" : webgpu && webcodecs ? "full" : "standard";
  return { tier, webgpu, webgl2, webcodecs, opfs, isolated: typeof crossOriginIsolated !== "undefined" && crossOriginIsolated, fsAccess: "showDirectoryPicker" in window, mobile, threads, memory, wakeLock: "wakeLock" in navigator };
}
