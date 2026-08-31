/**
 * PPT 模板库 (P2-5)
 *
 * 预定义常用幻灯片布局模板，用户可一键插入到当前 deck。
 * 对标 oh-my-ppt 的模板库功能。
 */

import type { V2Slide, SlideElement, PPTTheme } from './ppt-types';
import {
  createTextElement, createListElement, createShapeElement, createElementId,
} from './ppt-types';
import type { PPTStyle } from './ppt-styles';

export interface SlideTemplate {
  id: string;
  name: string;
  icon: string;
  category: 'cover' | 'content' | 'section' | 'data' | 'quote' | 'conclusion';
  description: string;
  /** 生成函数 — 根据当前主题和风格返回元素数组 */
  create: (style: PPTStyle, theme: PPTTheme) => SlideElement[];
}

const TEMPLATES: SlideTemplate[] = [
  {
    id: 'tpl-cover',
    name: '封面页',
    icon: '🎯',
    category: 'cover',
    description: '大标题 + 副标题 + 装饰条',
    create: (_style, theme) => [
      createShapeElement({ x: 0, y: 0, width: 100, height: 100, fill: theme.backgroundColor }),
      createShapeElement({ x: 5, y: 35, width: 6, height: 30, fill: theme.primaryColor, shape: 'rounded' }),
      createTextElement({
        x: 15, y: 30, width: 70, height: 25,
        content: '在此输入标题',
        fontSize: 48, fontWeight: 'bold', color: theme.textColor,
        textAlign: 'left',
      }),
      createTextElement({
        x: 15, y: 58, width: 70, height: 8,
        content: '副标题 / 日期 / 演讲者',
        fontSize: 18, fontWeight: 'normal', color: theme.textColor,
        textAlign: 'left',
      }),
    ],
  },
  {
    id: 'tpl-content',
    name: '标题+内容',
    icon: '📝',
    category: 'content',
    description: '标准标题 + 要点列表',
    create: (_style, theme) => [
      createShapeElement({ x: 0, y: 0, width: 100, height: 12, fill: theme.primaryColor }),
      createTextElement({
        x: 8, y: 16, width: 84, height: 10,
        content: '页面标题',
        fontSize: 32, fontWeight: 'bold', color: theme.textColor,
        textAlign: 'left',
      }),
      createListElement({
        x: 10, y: 32, width: 80, height: 55,
        items: ['要点一', '要点二', '要点三', '要点四'],
        fontSize: 20, color: theme.textColor, bulletColor: theme.accentColor,
      }),
    ],
  },
  {
    id: 'tpl-two-col',
    name: '双栏对比',
    icon: '⚖️',
    category: 'content',
    description: '左右两栏对比布局',
    create: (_style, theme) => [
      createTextElement({
        x: 8, y: 6, width: 84, height: 8,
        content: '对比标题',
        fontSize: 32, fontWeight: 'bold', color: theme.textColor,
        textAlign: 'center',
      }),
      createShapeElement({ x: 8, y: 18, width: 38, height: 70, fill: theme.backgroundColor, shape: 'rounded' }),
      createShapeElement({ x: 54, y: 18, width: 38, height: 70, fill: theme.backgroundColor, shape: 'rounded' }),
      createTextElement({
        x: 12, y: 22, width: 30, height: 6,
        content: '左侧',
        fontSize: 22, fontWeight: 'bold', color: theme.primaryColor, textAlign: 'center',
      }),
      createListElement({
        x: 12, y: 32, width: 30, height: 50,
        items: ['项目 A', '项目 B', '项目 C'],
        fontSize: 16, color: theme.textColor, bulletColor: theme.accentColor,
      }),
      createTextElement({
        x: 58, y: 22, width: 30, height: 6,
        content: '右侧',
        fontSize: 22, fontWeight: 'bold', color: theme.primaryColor, textAlign: 'center',
      }),
      createListElement({
        x: 58, y: 32, width: 30, height: 50,
        items: ['项目 X', '项目 Y', '项目 Z'],
        fontSize: 16, color: theme.textColor, bulletColor: theme.accentColor,
      }),
    ],
  },
  {
    id: 'tpl-section',
    name: '章节过渡',
    icon: '🔖',
    category: 'section',
    description: '全屏背景色 + 大标题',
    create: (_style, theme) => [
      createShapeElement({ x: 0, y: 0, width: 100, height: 100, fill: theme.primaryColor }),
      createTextElement({
        x: 10, y: 35, width: 80, height: 15,
        content: '章节标题',
        fontSize: 52, fontWeight: 'bold', color: '#ffffff', textAlign: 'center',
      }),
      createTextElement({
        x: 10, y: 55, width: 80, height: 8,
        content: '章节描述',
        fontSize: 20, fontWeight: 'normal', color: 'rgba(255,255,255,0.8)', textAlign: 'center',
      }),
    ],
  },
  {
    id: 'tpl-quote',
    name: '引用金句',
    icon: '💬',
    category: 'quote',
    description: '大引号 + 引文 + 出处',
    create: (_style, theme) => [
      createTextElement({
        x: 10, y: 10, width: 15, height: 20,
        content: '"',
        fontSize: 120, fontWeight: 'bold', color: theme.accentColor, textAlign: 'left',
      }),
      createTextElement({
        x: 20, y: 30, width: 65, height: 25,
        content: '在此输入引文内容',
        fontSize: 28, fontWeight: 'normal', color: theme.textColor, textAlign: 'left',
      }),
      createTextElement({
        x: 20, y: 65, width: 65, height: 8,
        content: '— 出处',
        fontSize: 18, fontWeight: 'bold', color: theme.textColor, textAlign: 'right',
      }),
    ],
  },
  {
    id: 'tpl-conclusion',
    name: '结论页',
    icon: '🏁',
    category: 'conclusion',
    description: '感谢 + 联系方式',
    create: (_style, theme) => [
      createShapeElement({ x: 0, y: 0, width: 100, height: 100, fill: theme.backgroundColor }),
      createShapeElement({ x: 35, y: 25, width: 30, height: 4, fill: theme.accentColor, shape: 'rounded' }),
      createTextElement({
        x: 10, y: 32, width: 80, height: 15,
        content: '谢谢观看',
        fontSize: 48, fontWeight: 'bold', color: theme.textColor, textAlign: 'center',
      }),
      createTextElement({
        x: 10, y: 55, width: 80, height: 8,
        content: '联系方式 / Q&A',
        fontSize: 18, fontWeight: 'normal', color: theme.textColor, textAlign: 'center',
      }),
    ],
  },
  {
    id: 'tpl-data',
    name: '数据卡片',
    icon: '📊',
    category: 'data',
    description: '三个数据指标卡片',
    create: (_style, theme) => [
      createTextElement({
        x: 8, y: 6, width: 84, height: 8,
        content: '数据概览',
        fontSize: 32, fontWeight: 'bold', color: theme.textColor, textAlign: 'left',
      }),
      ...[0, 1, 2].map(i => {
        const xPos = 8 + i * 29;
        return [
          createShapeElement({ x: xPos, y: 22, width: 26, height: 65, fill: theme.backgroundColor, shape: 'rounded' }),
          createTextElement({
            x: xPos, y: 32, width: 26, height: 12,
            content: ['100%', '50%', '25%'][i],
            fontSize: 40, fontWeight: 'bold', color: theme.primaryColor, textAlign: 'center',
          }),
          createTextElement({
            x: xPos, y: 52, width: 26, height: 6,
            content: ['指标一', '指标二', '指标三'][i],
            fontSize: 16, fontWeight: 'normal', color: theme.textColor, textAlign: 'center',
          }),
        ];
      }).flat(),
    ],
  },
];

export function getTemplates(): SlideTemplate[] {
  return TEMPLATES;
}

export function getTemplateById(id: string): SlideTemplate | undefined {
  return TEMPLATES.find(t => t.id === id);
}

/**
 * 从模板创建新幻灯片
 */
export function createSlideFromTemplate(
  templateId: string,
  style: PPTStyle,
  theme: PPTTheme,
  index: number,
): V2Slide | null {
  const tpl = getTemplateById(templateId);
  if (!tpl) return null;

  const elements = tpl.create(style, theme);
  return {
    id: createElementId(),
    index,
    elements,
    background: theme.backgroundColor,
    notes: '',
  };
}
