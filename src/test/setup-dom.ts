/**
 * @testing-library/jest-dom 全局初始化
 *
 * 注册 jest-dom 的自定义匹配器（toBeInTheDocument / toHaveTextContent / ...），
 * 让组件渲染测试可以写出更自然的断言。
 */
import "@testing-library/jest-dom/vitest";

// Suppress noisy console.log from SQLite in test output
const origLog = console.log;
console.log = (...args: unknown[]) => {
  const first = args[0];
  if (typeof first === "string" && first.startsWith("[Database]")) return;
  origLog(...args);
};
