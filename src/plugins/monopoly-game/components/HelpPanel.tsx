/**
 * HelpPanel — 帮助/规则面板 (G30)
 * 显示游戏操作指南和规则说明
 */

interface Props {
  onClose: () => void;
}

export function HelpPanel({ onClose }: Props) {
  return (
    <div className="card-panel-overlay">
      <div className="card-panel" style={{ width: 560, maxHeight: "85%", overflowY: "auto" }}>
        <div className="panel-header">
          <h3>游戏规则</h3>
          <button className="panel-close" onClick={onClose}>×</button>
        </div>

        <div style={{ color: "#ecf0f1", fontSize: 13, lineHeight: 1.8 }}>
          <h4 style={{ color: "#f1c40f", marginTop: 12 }}>基本玩法</h4>
          <p style={{ color: "#bdc3c7" }}>
            玩家轮流掷骰子前进，经过或到达地块时触发不同事件。目标是积累财富，在游戏结束时拥有最多资产。
          </p>

          <h4 style={{ color: "#f1c40f", marginTop: 12 }}>地块类型</h4>
          <ul style={{ color: "#bdc3c7", paddingLeft: 20 }}>
            <li><b style={{ color: "#27ae60" }}>空地</b> — 可购买或升级，他人经过需交过路费</li>
            <li><b style={{ color: "#3498db" }}>银行</b> — 可存款、贷款、还贷（有利息）</li>
            <li><b style={{ color: "#e74c3c" }}>商店</b> — 可购买卡牌和道具</li>
            <li><b style={{ color: "#9b59b6" }}>酒店</b> — 可能被强制住宿，消耗天数</li>
            <li><b style={{ color: "#f39c12" }}>加油站</b> — 开车/机车需加油</li>
            <li><b style={{ color: "#e91e63" }}>医院</b> — 受伤时住院，无法行动</li>
            <li><b style={{ color: "#c0392b" }}>监狱</b> — 可能被关押，需等待释放</li>
            <li><b style={{ color: "#1abc9c" }}>魔法屋</b> — 随机获得正面或负面效果</li>
            <li><b style={{ color: "#2ecc71" }}>新闻/命运</b> — 触发随机事件，可能获得卡牌</li>
            <li><b style={{ color: "#f1c40f" }}>拍卖行</b> — 可发起地产拍卖</li>
            <li><b style={{ color: "#3498db" }}>机场</b> — 付费传送至任意位置</li>
            <li><b style={{ color: "#e67e22" }}>商业地块</b> — 保险/建筑公司，可购买所有权</li>
          </ul>

          <h4 style={{ color: "#f1c40f", marginTop: 12 }}>操作指南</h4>
          <ul style={{ color: "#bdc3c7", paddingLeft: 20 }}>
            <li><b>掷骰子</b> — 当前玩家回合开始时点击掷骰</li>
            <li><b>购买地块</b> — 到达空地时可购买</li>
            <li><b>升级地产</b> — 到达自己的地产可升级（提高过路费）</li>
            <li><b>卖地</b> — 点击"卖地"按钮可主动出售自有地产</li>
            <li><b>投降</b> — 点击"投降"按钮认输退出</li>
            <li><b>股票</b> — 打开股票面板可买卖股票</li>
            <li><b>卡牌/道具</b> — 使用获得的卡牌和道具影响游戏</li>
            <li><b>存档/读档</b> — 随时保存或加载游戏进度</li>
          </ul>

          <h4 style={{ color: "#f1c40f", marginTop: 12 }}>经济系统</h4>
          <ul style={{ color: "#bdc3c7", paddingLeft: 20 }}>
            <li><b>物价指数</b> — 随游戏进行动态变化，影响过路费和物价</li>
            <li><b>银行利息</b> — 存款产生利息，贷款也需支付利息</li>
            <li><b>股票分红</b> — 每回合自动发放持有股票的分红</li>
            <li><b>破产</b> — 现金不足且无法变现资产时破产</li>
          </ul>

          <h4 style={{ color: "#f1c40f", marginTop: 12 }}>神仙系统</h4>
          <ul style={{ color: "#bdc3c7", paddingLeft: 20 }}>
            <li><b style={{ color: "#f1c40f" }}>大/小财神</b> — 增加收入，减少支出</li>
            <li><b style={{ color: "#e74c3c" }}>大/小穷神</b> — 减少收入，增加支出</li>
          </ul>

          <h4 style={{ color: "#f1c40f", marginTop: 12 }}>热座模式</h4>
          <p style={{ color: "#bdc3c7" }}>
            可选择多个人类玩家，轮流在同一设备上操作。AI 数量自动调整。
          </p>

          <h4 style={{ color: "#f1c40f", marginTop: 12 }}>胜利条件</h4>
          <p style={{ color: "#bdc3c7" }}>
            默认按游戏天数结束后比较总资产。也可选择"倍数胜利"：当某玩家总资产达到初始资金的指定倍数时立即获胜。
          </p>
        </div>
      </div>
    </div>
  );
}
