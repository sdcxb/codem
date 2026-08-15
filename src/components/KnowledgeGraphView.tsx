/**
 * KnowledgeGraphView — 知识图谱可视化组件
 *
 * 借鉴思路来源: Understand-Anything (https://github.com/Egonex-AI/Understand-Anything)
 * 该项目使用 React Flow 库渲染力导向图;
 * 我们自研实现: 纯 Canvas 2D 实现力导向布局算法, 不依赖任何外部图谱库
 *
 * 核心自研内容:
 * - 力导向布局算法 (库仑斥力 + 胡克引力 + 阻尼)
 * - Canvas 节点渲染 (按实体类型着色)
 * - 节点交互 (点击选中、拖拽、高亮关联)
 * - 皮肤系统兼容 (读取 SkinConfig 颜色)
 *
 * 皮肤系统兼容:
 * - 读取当前皮肤的 colors 配置 (bgPrimary, accent, textPrimary 等)
 * - 支持 default (暗色/亮色)、hub (深色科技)、dream (梦幻浅色) 三套皮肤
 */

import { useRef, useEffect, useState, useCallback } from 'react';
import { Loader2, Search, Share2, ZoomIn, ZoomOut, Maximize2, Download, Edit3, Trash2, Plus } from 'lucide-react';
import { ActionIcons } from '../core/icons/icon-map';
import { useSkin } from '../core/theme';
import { getGraphData, updateGraphNode, deleteGraphNode, deleteGraphEdge, addGraphEdge } from '../core/knowledge';
import type { GraphData, GraphNode, GraphEdge, EntityType, RelationType } from '../core/knowledge';
import { useLang } from '../core/i18n/lang';

interface KnowledgeGraphViewProps {
  notebookId: string;
  onNodeSelect?: (node: GraphNode) => void;
}

/** 力导向布局中的节点物理状态 */
interface PhysicsNode {
  id: string;
  label: string;
  entityType: EntityType;
  x: number;
  y: number;
  vx: number;
  vy: number;
  weight: number;
  communityId?: number;
  description?: string;
  fixed: boolean;
}

/** 力导向布局中的边 */
interface PhysicsEdge {
  source: string;
  target: string;
  relationType: string;
}

/** 实体类型颜色映射 (基于皮肤 accent 色的变体) */
function getEntityColor(entityType: EntityType, accent: string, isDark: boolean): string {
  const colorMap: Record<EntityType, string> = {
    concept: accent,
    entity: isDark ? '#58a6ff' : '#0969da',
    event: isDark ? '#d29922' : '#bf8700',
    person: isDark ? '#f85149' : '#cf222e',
    place: isDark ? '#3fb950' : '#1a7f37',
    organization: isDark ? '#bc8cff' : '#8250df',
    technology: isDark ? '#7ee787' : '#0550ae',
  };
  return colorMap[entityType] || accent;
}

/** 判断皮肤是否为暗色 */
function isDarkSkin(skinId: string): boolean {
  return skinId === 'default' || skinId === 'hub';
}

/** C3: Calculate distance from point to line segment */
function pointToLineDist(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  return Math.sqrt((px - projX) ** 2 + (py - projY) ** 2);
}

export function KnowledgeGraphView({ notebookId, onNodeSelect }: KnowledgeGraphViewProps) {
  const lang = useLang();
  const isZh = lang === 'zh';
  const { skin } = useSkin();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [loading, setLoading] = useState(false);
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], edges: [] });
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

  // C3: Graph editing state
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId?: string; edgeIdx?: number } | null>(null);
  const [edgeCreateFrom, setEdgeCreateFrom] = useState<string | null>(null);

  // Physics simulation state
  const physicsNodesRef = useRef<Map<string, PhysicsNode>>(new Map());
  const physicsEdgesRef = useRef<PhysicsEdge[]>([]);
  const animationRef = useRef<number>(0);
  const dragNodeRef = useRef<string | null>(null);
  const offsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const scaleRef = useRef<number>(1);
  const panRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Load graph data
  const loadGraph = useCallback(async () => {
    setLoading(true);
    try {
      const { extractKnowledgeGraph } = await import('../core/knowledge');
      // Check if graph already exists
      const existing = getGraphData(notebookId);
      if (existing.nodes.length > 0) {
        setGraphData(existing);
        initPhysics(existing);
      } else {
        // Extract new graph
        const data = await extractKnowledgeGraph(notebookId);
        setGraphData(data);
        initPhysics(data);
      }
    } catch (e) {
      console.error('Failed to load graph:', e);
    } finally {
      setLoading(false);
    }
  }, [notebookId]);

  // Initialize physics simulation
  const initPhysics = (data: GraphData) => {
    const nodes = new Map<string, PhysicsNode>();
    const centerX = 400;
    const centerY = 300;

    data.nodes.forEach((node, i) => {
      // Distribute nodes in a circle initially
      const angle = (i / Math.max(data.nodes.length, 1)) * Math.PI * 2;
      const radius = 150 + Math.random() * 100;
      nodes.set(node.id, {
        id: node.id,
        label: node.label,
        entityType: node.entityType,
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
        weight: node.weight,
        communityId: node.communityId,
        description: node.description,
        fixed: false,
      });
    });

    physicsNodesRef.current = nodes;
    physicsEdgesRef.current = data.edges.map(e => ({
      source: e.sourceNodeId,
      target: e.targetNodeId,
      relationType: e.relationType,
    }));
  };

  // Force simulation step
  const simulate = useCallback(() => {
    const nodes = physicsNodesRef.current;
    const edges = physicsEdgesRef.current;
    if (nodes.size === 0) return;

    const REPULSION = 8000;     // 库仑斥力强度
    const ATTRACTION = 0.02;    // 胡克引力强度
    const DAMPING = 0.85;       // 阻尼系数
    const CENTER_FORCE = 0.001; // 向中心收束的力
    const MAX_VELOCITY = 10;

    const nodeArray = Array.from(nodes.values());

    // Repulsion (Coulomb's law between all pairs)
    for (let i = 0; i < nodeArray.length; i++) {
      for (let j = i + 1; j < nodeArray.length; j++) {
        const a = nodeArray[i];
        const b = nodeArray[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distSq = dx * dx + dy * dy + 0.01;
        const dist = Math.sqrt(distSq);
        const force = REPULSION / distSq;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        if (!a.fixed) { a.vx -= fx; a.vy -= fy; }
        if (!b.fixed) { b.vx += fx; b.vy += fy; }
      }
    }

    // Attraction (Hooke's law for connected nodes)
    for (const edge of edges) {
      const a = nodes.get(edge.source);
      const b = nodes.get(edge.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const force = ATTRACTION * dist;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      if (!a.fixed) { a.vx += fx; a.vy += fy; }
      if (!b.fixed) { b.vx -= fx; b.vy -= fy; }
    }

    // Center force
    const centerX = 400;
    const centerY = 300;
    for (const node of nodeArray) {
      if (node.fixed) continue;
      node.vx += (centerX - node.x) * CENTER_FORCE;
      node.vy += (centerY - node.y) * CENTER_FORCE;
    }

    // Apply velocity with damping
    for (const node of nodeArray) {
      if (node.fixed) continue;
      node.vx *= DAMPING;
      node.vy *= DAMPING;
      // Clamp velocity
      node.vx = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, node.vx));
      node.vy = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, node.vy));
      node.x += node.vx;
      node.y += node.vy;
    }
  }, []);

  // Render canvas
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = container.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;

    const dark = isDarkSkin(skin);
    const accent = skin === 'hub' ? '#ff6b00' : skin === 'dream' ? '#e88c9a' : '#7c6cf0';
    const bgColor = skin === 'hub' ? '#0a0a0a' : skin === 'dream' ? '#fdf5f7' : 'rgba(13, 17, 23, 0.85)';
    const textColor = skin === 'hub' ? '#e0e0e0' : skin === 'dream' ? '#6c474d' : '#f0f6fc';
    const textSecondaryColor = skin === 'hub' ? '#888888' : skin === 'dream' ? '#a88a8f' : '#8b949e';

    // Clear canvas
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const nodes = physicsNodesRef.current;
    const edges = physicsEdgesRef.current;
    const scale = scaleRef.current;
    const pan = panRef.current;

    ctx.save();
    ctx.translate(pan.x, pan.y);
    ctx.scale(scale, scale);

    // Draw edges
    for (const edge of edges) {
      const a = nodes.get(edge.source);
      const b = nodes.get(edge.target);
      if (!a || !b) continue;

      const isHighlighted = hoveredNode === a.id || hoveredNode === b.id ||
        selectedNode?.id === a.id || selectedNode?.id === b.id;

      ctx.strokeStyle = isHighlighted ? accent : (dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)');
      ctx.lineWidth = isHighlighted ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();

      // Draw relation label on highlighted edges
      if (isHighlighted) {
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        ctx.fillStyle = textSecondaryColor;
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(edge.relationType, midX, midY - 4);
      }
    }

    // Draw nodes
    for (const node of nodes.values()) {
      const isSelected = selectedNode?.id === node.id;
      const isHovered = hoveredNode === node.id;
      const isMatch = searchQuery && node.label.toLowerCase().includes(searchQuery.toLowerCase());

      const radius = 6 + Math.min(node.weight * 2, 12);
      const color = getEntityColor(node.entityType, accent, dark);

      // Glow effect for selected/hovered/matched nodes
      if (isSelected || isHovered || isMatch) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 20;
      }

      // Node circle
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
      ctx.fill();

      // Node border
      ctx.shadowBlur = 0;
      ctx.strokeStyle = isSelected ? '#ffffff' : (dark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.2)');
      ctx.lineWidth = isSelected ? 3 : 1.5;
      ctx.stroke();

      // Node label
      ctx.fillStyle = textColor;
      ctx.font = `${isSelected ? 'bold ' : ''}12px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(node.label, node.x, node.y + radius + 14);
    }

    ctx.restore();
  }, [skin, hoveredNode, selectedNode, searchQuery]);

  // Animation loop
  useEffect(() => {
    let frameCount = 0;
    const animate = () => {
      // Only simulate for first 300 frames, then let it settle
      if (frameCount < 300) {
        simulate();
      }
      render();
      frameCount++;
      animationRef.current = requestAnimationFrame(animate);
    };
    animate();
    return () => cancelAnimationFrame(animationRef.current);
  }, [simulate, render]);

  // Load on mount
  useEffect(() => {
    loadGraph();
  }, [loadGraph]);

  // Canvas interaction handlers
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left - panRef.current.x) / scaleRef.current;
    const y = (e.clientY - rect.top - panRef.current.y) / scaleRef.current;

    // Check if clicking on a node
    for (const node of physicsNodesRef.current.values()) {
      const dx = node.x - x;
      const dy = node.y - y;
      const radius = 6 + Math.min(node.weight * 2, 12);
      if (dx * dx + dy * dy < (radius + 5) * (radius + 5)) {
        dragNodeRef.current = node.id;
        node.fixed = true;
        offsetRef.current = { x: x - node.x, y: y - node.y };
        return;
      }
    }

    // Otherwise pan
    dragNodeRef.current = '__pan__';
    offsetRef.current = { x: e.clientX - panRef.current.x, y: e.clientY - panRef.current.y };
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left - panRef.current.x) / scaleRef.current;
    const y = (e.clientY - rect.top - panRef.current.y) / scaleRef.current;

    if (dragNodeRef.current === '__pan__') {
      panRef.current = {
        x: e.clientX - offsetRef.current.x,
        y: e.clientY - offsetRef.current.y,
      };
      return;
    }

    if (dragNodeRef.current) {
      const node = physicsNodesRef.current.get(dragNodeRef.current);
      if (node) {
        node.x = x - offsetRef.current.x;
        node.y = y - offsetRef.current.y;
        node.vx = 0;
        node.vy = 0;
      }
      return;
    }

    // Hover detection
    let foundHover: string | null = null;
    for (const node of physicsNodesRef.current.values()) {
      const dx = node.x - x;
      const dy = node.y - y;
      const radius = 6 + Math.min(node.weight * 2, 12);
      if (dx * dx + dy * dy < (radius + 5) * (radius + 5)) {
        foundHover = node.id;
        break;
      }
    }
    if (foundHover !== hoveredNode) {
      setHoveredNode(foundHover);
      canvas.style.cursor = foundHover ? 'pointer' : 'default';
    }
  };

  const handleMouseUp = () => {
    if (dragNodeRef.current && dragNodeRef.current !== '__pan__') {
      const node = physicsNodesRef.current.get(dragNodeRef.current);
      if (node) node.fixed = false;
    }
    dragNodeRef.current = null;
  };

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left - panRef.current.x) / scaleRef.current;
    const y = (e.clientY - rect.top - panRef.current.y) / scaleRef.current;

    for (const node of physicsNodesRef.current.values()) {
      const dx = node.x - x;
      const dy = node.y - y;
      const radius = 6 + Math.min(node.weight * 2, 12);
      if (dx * dx + dy * dy < (radius + 5) * (radius + 5)) {
        // C3: If in edge-create mode, create edge between nodes
        if (edgeCreateFrom && edgeCreateFrom !== node.id) {
          addGraphEdge(notebookId, edgeCreateFrom, node.id, 'related' as RelationType);
          setEdgeCreateFrom(null);
          loadGraph();
          return;
        }
        // Find original GraphNode
        const original = graphData.nodes.find(n => n.id === node.id);
        if (original) {
          setSelectedNode(original);
          onNodeSelect?.(original);
        }
        return;
      }
    }
    setSelectedNode(null);
    setEdgeCreateFrom(null);
  };

  // C3: Double-click to edit node label
  const handleDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left - panRef.current.x) / scaleRef.current;
    const y = (e.clientY - rect.top - panRef.current.y) / scaleRef.current;

    for (const node of physicsNodesRef.current.values()) {
      const dx = node.x - x;
      const dy = node.y - y;
      const radius = 6 + Math.min(node.weight * 2, 12);
      if (dx * dx + dy * dy < (radius + 5) * (radius + 5)) {
        setEditingNodeId(node.id);
        setEditLabel(node.label);
        return;
      }
    }
  };

  // C3: Right-click context menu
  const handleContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left - panRef.current.x) / scaleRef.current;
    const y = (e.clientY - rect.top - panRef.current.y) / scaleRef.current;

    // Check if clicking on a node
    for (const node of physicsNodesRef.current.values()) {
      const dx = node.x - x;
      const dy = node.y - y;
      const radius = 6 + Math.min(node.weight * 2, 12);
      if (dx * dx + dy * dy < (radius + 5) * (radius + 5)) {
        setContextMenu({ x: e.clientX, y: e.clientY, nodeId: node.id });
        return;
      }
    }

    // Check if clicking near an edge
    const edges = physicsEdgesRef.current;
    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i];
      const a = physicsNodesRef.current.get(edge.source);
      const b = physicsNodesRef.current.get(edge.target);
      if (!a || !b) continue;
      // Check distance from point to line segment
      const dist = pointToLineDist(x, y, a.x, a.y, b.x, b.y);
      if (dist < 8) {
        setContextMenu({ x: e.clientX, y: e.clientY, edgeIdx: i });
        return;
      }
    }
  };

  // C3: Save edited node label
  const handleSaveEdit = () => {
    if (editingNodeId && editLabel.trim()) {
      updateGraphNode(editingNodeId, { label: editLabel.trim() });
      setEditingNodeId(null);
      loadGraph();
    }
  };

  // C3: Delete node from context menu
  const handleDeleteNode = (nodeId: string) => {
    deleteGraphNode(nodeId);
    setContextMenu(null);
    setSelectedNode(null);
    loadGraph();
  };

  // C3: Delete edge from context menu
  const handleDeleteEdge = (edgeIdx: number) => {
    const edge = physicsEdgesRef.current[edgeIdx];
    if (edge) {
      // Find the actual edge ID from graphData
      const graphEdge = graphData.edges.find(e =>
        e.sourceNodeId === edge.source && e.targetNodeId === edge.target
      );
      if (graphEdge) {
        deleteGraphEdge(graphEdge.id);
        loadGraph();
      }
    }
    setContextMenu(null);
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    scaleRef.current = Math.max(0.3, Math.min(3, scaleRef.current * delta));
  };

  const handleZoomIn = () => { scaleRef.current = Math.min(3, scaleRef.current * 1.2); };
  const handleZoomOut = () => { scaleRef.current = Math.max(0.3, scaleRef.current * 0.8); };
  const handleReset = () => { scaleRef.current = 1; panRef.current = { x: 0, y: 0 }; };

  // Get connected nodes for selected node
  const connectedNodes = selectedNode
    ? graphData.edges
        .filter(e => e.sourceNodeId === selectedNode.id || e.targetNodeId === selectedNode.id)
        .map(e => {
          const otherId = e.sourceNodeId === selectedNode.id ? e.targetNodeId : e.sourceNodeId;
          return graphData.nodes.find(n => n.id === otherId);
        })
        .filter((n): n is GraphNode => n !== undefined)
    : [];

  // Skin-based styling
  const dark = isDarkSkin(skin);
  const bgColor = skin === 'hub' ? '#0a0a0a' : skin === 'dream' ? '#fdf5f7' : '#0d1117';
  const bgSecondary = skin === 'hub' ? '#121212' : skin === 'dream' ? '#ffffff' : '#161b22';
  const bgTertiary = skin === 'hub' ? '#1c1c1e' : skin === 'dream' ? '#fce8eb' : '#21262d';
  const textColor = skin === 'hub' ? '#e0e0e0' : skin === 'dream' ? '#6c474d' : '#f0f6fc';
  const textSecondaryColor = skin === 'hub' ? '#888888' : skin === 'dream' ? '#a88a8f' : '#8b949e';
  const borderColor = skin === 'hub' ? '#2a2a2a' : skin === 'dream' ? '#f7dee2' : '#30363d';
  const accentColor = skin === 'hub' ? '#ff6b00' : skin === 'dream' ? '#e88c9a' : '#7c6cf0';

  if (loading) {
    return (
      <div className="kg-loading" style={{ background: bgColor, color: textColor }}>
        <Loader2 size={24} className="animate-spin" style={{ color: accentColor }} />
        <span style={{ color: textSecondaryColor }}>
          {isZh ? '正在提取知识图谱...' : 'Extracting knowledge graph...'}
        </span>
      </div>
    );
  }

  if (graphData.nodes.length === 0) {
    return (
      <div className="kg-empty" style={{ background: bgColor, color: textSecondaryColor }}>
        <Share2 size={48} style={{ opacity: 0.3 }} />
        <p>{isZh ? '暂无图谱数据，请先添加并索引来源' : 'No graph data. Add and index sources first.'}</p>
        <button
          onClick={loadGraph}
          style={{ background: accentColor, color: '#fff' }}
          className="kg-retry-btn"
        >
          {isZh ? '重新提取' : 'Extract Again'}
        </button>
      </div>
    );
  }

  return (
    <div className="kg-container" style={{ background: bgColor, color: textColor }}>
      {/* Toolbar */}
      <div className="kg-toolbar" style={{ background: bgSecondary, borderBottom: `1px solid ${borderColor}` }}>
        <div className="kg-search-wrapper">
          <Search size={14} style={{ color: textSecondaryColor }} />
          <input
            className="kg-search-input"
            placeholder={isZh ? '搜索节点...' : 'Search nodes...'}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ background: bgTertiary, color: textColor, border: `1px solid ${borderColor}` }}
          />
        </div>
        <div className="kg-toolbar-actions">
          <button className="kg-tool-btn" onClick={handleZoomIn} title={isZh ? '放大' : 'Zoom In'}>
            <ZoomIn size={16} />
          </button>
          <button className="kg-tool-btn" onClick={handleZoomOut} title={isZh ? '缩小' : 'Zoom Out'}>
            <ZoomOut size={16} />
          </button>
          <button className="kg-tool-btn" onClick={handleReset} title={isZh ? '重置' : 'Reset'}>
            <Maximize2 size={16} />
          </button>
          <button
            className="kg-tool-btn kg-refresh-btn"
            onClick={loadGraph}
            title={isZh ? '重新提取图谱' : 'Re-extract Graph'}
            style={{ color: accentColor }}
          >
            <Loader2 size={16} />
          </button>
          {/* B7: 导出图谱 */}
          <button
            className="kg-tool-btn"
            onClick={() => {
              const canvas = canvasRef.current;
              if (!canvas) return;
              const link = document.createElement('a');
              link.download = `knowledge-graph-${Date.now()}.png`;
              link.href = canvas.toDataURL('image/png');
              link.click();
            }}
            title={isZh ? '导出为 PNG' : 'Export as PNG'}
          >
            <Download size={16} />
          </button>
          <button
            className="kg-tool-btn"
            onClick={() => {
              const data = { nodes: graphData.nodes, edges: graphData.edges, exportedAt: new Date().toISOString() };
              const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `knowledge-graph-${Date.now()}.json`;
              a.click();
              URL.revokeObjectURL(url);
            }}
            title={isZh ? '导出为 JSON' : 'Export as JSON'}
            style={{ fontSize: '10px' }}
          >
            JSON
          </button>
        </div>
      </div>

      {/* Canvas + Sidebar */}
      <div className="kg-body">
        <div ref={containerRef} className="kg-canvas-wrapper">
          <canvas
            ref={canvasRef}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onClick={handleClick}
            onDoubleClick={handleDoubleClick}
            onContextMenu={handleContextMenu}
            onWheel={handleWheel}
            className="kg-canvas"
          />
        </div>

        {/* Node Detail Sidebar */}
        {selectedNode && (
          <div className="kg-sidebar" style={{ background: bgSecondary, borderLeft: `1px solid ${borderColor}` }}>
            <div className="kg-sidebar-header" style={{ borderBottom: `1px solid ${borderColor}` }}>
              <h3 style={{ color: accentColor }}>{selectedNode.label}</h3>
              <span
                className="kg-entity-badge"
                style={{ background: getEntityColor(selectedNode.entityType, accentColor, dark), color: '#fff' }}
              >
                {selectedNode.entityType}
              </span>
            </div>

            {selectedNode.description && (
              <div className="kg-detail-section">
                <h4 style={{ color: textSecondaryColor }}>{isZh ? '描述' : 'Description'}</h4>
                <p style={{ color: textColor }}>{selectedNode.description}</p>
              </div>
            )}

            <div className="kg-detail-section">
              <h4 style={{ color: textSecondaryColor }}>{isZh ? '权重' : 'Weight'}</h4>
              <p style={{ color: textColor }}>{selectedNode.weight}</p>
            </div>

            <div className="kg-detail-section">
              <h4 style={{ color: textSecondaryColor }}>
                {isZh ? '关联实体' : 'Connected Entities'} ({connectedNodes.length})
              </h4>
              <div className="kg-connected-list">
                {connectedNodes.map((node) => (
                  <button
                    key={node.id}
                    className="kg-connected-item"
                    onClick={() => setSelectedNode(node)}
                    style={{ background: bgTertiary, border: `1px solid ${borderColor}`, color: textColor }}
                  >
                    <span
                      className="kg-connected-dot"
                      style={{ background: getEntityColor(node.entityType, accentColor, dark) }}
                    />
                    {node.label}
                  </button>
                ))}
              </div>
            </div>

            {selectedNode.sourceIds.length > 0 && (
              <div className="kg-detail-section">
                <h4 style={{ color: textSecondaryColor }}>
                  {isZh ? '来源' : 'Sources'} ({selectedNode.sourceIds.length})
                </h4>
                <p style={{ color: textSecondaryColor, fontSize: '12px' }}>
                  {isZh ? '该实体出现在多个来源中' : 'This entity appears in multiple sources'}
                </p>
              </div>
            )}

            {/* C3: Edit actions */}
            <div className="kg-detail-section">
              <button
                onClick={() => {
                  setEditingNodeId(selectedNode.id);
                  setEditLabel(selectedNode.label);
                }}
                style={{
                  width: '100%', padding: '6px', marginBottom: '6px',
                  background: bgTertiary, border: `1px solid ${borderColor}`,
                  borderRadius: '6px', color: textColor, cursor: 'pointer',
                  fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'center',
                }}
              >
                <Edit3 size={12} />
                {isZh ? '编辑节点' : 'Edit Node'}
              </button>
              <button
                onClick={() => {
                  if (edgeCreateFrom === selectedNode.id) {
                    setEdgeCreateFrom(null);
                  } else {
                    setEdgeCreateFrom(selectedNode.id);
                  }
                }}
                style={{
                  width: '100%', padding: '6px', marginBottom: '6px',
                  background: edgeCreateFrom === selectedNode.id ? accentColor : bgTertiary,
                  border: `1px solid ${borderColor}`,
                  borderRadius: '6px',
                  color: edgeCreateFrom === selectedNode.id ? '#fff' : textColor,
                  cursor: 'pointer',
                  fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'center',
                }}
              >
                <Plus size={12} />
                {edgeCreateFrom === selectedNode.id
                  ? (isZh ? '取消连线' : 'Cancel Link')
                  : (isZh ? '创建连线' : 'Create Link')}
              </button>
              <button
                onClick={() => handleDeleteNode(selectedNode.id)}
                style={{
                  width: '100%', padding: '6px',
                  background: 'transparent', border: `1px solid #ef444455`,
                  borderRadius: '6px', color: '#ef4444', cursor: 'pointer',
                  fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'center',
                }}
              >
                <Trash2 size={12} />
                {isZh ? '删除节点' : 'Delete Node'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="kg-legend" style={{ background: bgSecondary, borderTop: `1px solid ${borderColor}` }}>
        {(['concept', 'entity', 'event', 'person', 'place', 'organization', 'technology'] as EntityType[]).map(type => (
          <div key={type} className="kg-legend-item">
            <span
              className="kg-legend-dot"
              style={{ background: getEntityColor(type, accentColor, dark) }}
            />
            <span style={{ color: textSecondaryColor }}>{type}</span>
          </div>
        ))}
        <div className="kg-legend-item" style={{ marginLeft: 'auto' }}>
          <span style={{ color: textSecondaryColor, fontSize: '10px' }}>
            {isZh ? '双击编辑 · 右键删除 · 侧栏连线' : 'Double-click to edit · Right-click to delete · Sidebar to link'}
          </span>
        </div>
      </div>

      {/* C3: Inline node label editor */}
      {editingNodeId && (
        <div
          className="nb-dialog-overlay"
          onClick={() => setEditingNodeId(null)}
          style={{ background: 'transparent', pointerEvents: 'auto' }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'absolute',
              left: '50%', top: '50%',
              transform: 'translate(-50%, -50%)',
              background: bgSecondary, border: `1px solid ${borderColor}`,
              borderRadius: '8px', padding: '16px',
              display: 'flex', flexDirection: 'column', gap: '8px',
              minWidth: '300px',
            }}
          >
            <label style={{ fontSize: '12px', color: textSecondaryColor }}>
              {isZh ? '编辑节点标签' : 'Edit Node Label'}
            </label>
            <input
              type="text"
              value={editLabel}
              onChange={(e) => setEditLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSaveEdit();
                if (e.key === 'Escape') setEditingNodeId(null);
              }}
              autoFocus
              style={{
                padding: '6px 8px', background: bgTertiary,
                border: `1px solid ${borderColor}`, borderRadius: '4px',
                color: textColor, fontSize: '13px', outline: 'none',
              }}
            />
            <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setEditingNodeId(null)}
                style={{
                  padding: '4px 12px', background: 'transparent',
                  border: `1px solid ${borderColor}`, borderRadius: '4px',
                  color: textColor, cursor: 'pointer', fontSize: '12px',
                }}
              >
                {isZh ? '取消' : 'Cancel'}
              </button>
              <button
                onClick={handleSaveEdit}
                style={{
                  padding: '4px 12px', background: accentColor,
                  border: 'none', borderRadius: '4px',
                  color: '#fff', cursor: 'pointer', fontSize: '12px',
                }}
              >
                {isZh ? '保存' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* C3: Right-click context menu */}
      {contextMenu && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
            onClick={() => setContextMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }}
          />
          <div
            style={{
              position: 'fixed',
              left: contextMenu.x, top: contextMenu.y,
              zIndex: 9999,
              background: bgSecondary, border: `1px solid ${borderColor}`,
              borderRadius: '6px', padding: '4px',
              boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
              minWidth: '140px',
            }}
          >
            {contextMenu.nodeId && (
              <>
                <button
                  onClick={() => {
                    setEditingNodeId(contextMenu.nodeId!);
                    const node = physicsNodesRef.current.get(contextMenu.nodeId!);
                    if (node) setEditLabel(node.label);
                    setContextMenu(null);
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '6px',
                    width: '100%', padding: '6px 8px',
                    background: 'transparent', border: 'none',
                    color: textColor, cursor: 'pointer', fontSize: '12px',
                    borderRadius: '4px', textAlign: 'left',
                  }}
                >
                  <Edit3 size={12} />
                  {isZh ? '编辑标签' : 'Edit Label'}
                </button>
                <button
                  onClick={() => {
                    setEdgeCreateFrom(contextMenu.nodeId!);
                    setContextMenu(null);
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '6px',
                    width: '100%', padding: '6px 8px',
                    background: 'transparent', border: 'none',
                    color: textColor, cursor: 'pointer', fontSize: '12px',
                    borderRadius: '4px', textAlign: 'left',
                  }}
                >
                  <Plus size={12} />
                  {isZh ? '创建连线' : 'Create Link'}
                </button>
                <div style={{ height: '1px', background: borderColor, margin: '2px 0' }} />
                <button
                  onClick={() => handleDeleteNode(contextMenu.nodeId!)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '6px',
                    width: '100%', padding: '6px 8px',
                    background: 'transparent', border: 'none',
                    color: '#ef4444', cursor: 'pointer', fontSize: '12px',
                    borderRadius: '4px', textAlign: 'left',
                  }}
                >
                  <Trash2 size={12} />
                  {isZh ? '删除节点' : 'Delete Node'}
                </button>
              </>
            )}
            {contextMenu.edgeIdx !== undefined && (
              <button
                onClick={() => handleDeleteEdge(contextMenu.edgeIdx!)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '6px',
                  width: '100%', padding: '6px 8px',
                  background: 'transparent', border: 'none',
                  color: '#ef4444', cursor: 'pointer', fontSize: '12px',
                  borderRadius: '4px', textAlign: 'left',
                }}
              >
                <Trash2 size={12} />
                {isZh ? '删除连线' : 'Delete Edge'}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
