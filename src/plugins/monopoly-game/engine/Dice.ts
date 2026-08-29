/**
 * Dice — 骰子系统
 * 交通方式决定骰子数量（步行1/机车2/汽车3）
 * 支持预言值（遥控骰子道具）
 */

export class Dice {
  private values: number[] = [1, 2, 3, 4, 5, 6];
  private prophecy: number | null = null;

  constructor(values?: number[]) {
    if (values) this.values = [...values];
  }

  setProphecy(value: number | null): void {
    this.prophecy = value;
  }

  getProphecy(): number | null {
    return this.prophecy;
  }

  /** 掷骰子，返回结果值 */
  roll(): number {
    if (this.prophecy !== null) {
      const r = this.prophecy;
      this.prophecy = null;
      return r;
    }
    return this.values[Math.floor(Math.random() * this.values.length)];
  }

  /** 掷多颗骰子 */
  static rollMultiple(count: number, prophecy?: number | null): number[] {
    const dice = new Dice();
    if (prophecy !== null && prophecy !== undefined) {
      dice.setProphecy(prophecy);
    }
    const results: number[] = [];
    for (let i = 0; i < count; i++) {
      results.push(dice.roll());
    }
    return results;
  }

  /** 获取总值 */
  static sum(results: number[]): number {
    return results.reduce((a, b) => a + b, 0);
  }
}
