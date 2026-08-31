/**
 * KnowledgeGraphView — 知识图谱可视化组件 (React Flow 版本)
 *
 * 借鉴来源: Understand-Anything (https://github.com/Egonex-AI/Understand-Anything)
 * 使用 @xyflow/react (React Flow) 库渲染交互式力导向图
 *
 * 核心特性:
 * - React Flow 力导向布局 (dagre auto-layout + 可拖拽节点)
 * - 自定义节点组件 (按实体类型着色 + 图标)
 * - 贝塞尔曲线边 + 关系标签
 * - MiniMap / Controls / Background 内置面板
 * - 节点交互 (点击选中、双击打开文档、右键菜单)
 * - 搜索高亮 / 关联节点 dimmed 效果
 * - 皮肤系统兼容
 * - 编辑功能 (编辑标签 / 创建连线 / 删除节点和边)
 * - 导出 PNG / JSON
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeProps,
  type EdgeProps,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  Position,
  BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Loader2, Search, Share2, Download, Edit3, Trash2 } from 'lucide-react';
import { useSkin } from '../core/theme';
import { getGraphData, updateGraphNode, deleteGraphNode, deleteGraphEdge } from '../core/knowledge';
import type { GraphData, GraphNode, GraphEdge, EntityType } from '../core/knowledge';
import { useLang } from '../core/i18n/lang';
import { createPortal } from 'react-dom';

// ========== Types ==========

interface KnowledgeGraphViewProps {
  notebookId: string;
  onNodeSelect?: (node: GraphNode) => void;
}

interface KGNodeData {
  label: string;
  entityType: EntityType;
  weight: number;
  description?: string;
  communityId?: number;
  sourceIds?: string[];
  [key: string]: unknown;
}

type KGFlowNode = Node<KGNodeData, 'kgNode'>;

interface KGEdgeData {
  relationType: string;
  [key: string]: unknown;
}

type KGFlowEdge = Edge<KGEdgeData, 'kgEdge'>;

// ========== Helpers ==========

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

function getEntityIcon(entityType: EntityType): string {
  const iconMap: Record<EntityType, string> = {
    concept: '💡', entity: '📌', event: '⚡', person: '👤',
    place: '📍', organization: '🏢', technology: '⚙️',
  };
  return iconMap[entityType] || '●';
}

function getEntityLabel(entityType: EntityType, isZh: boolean): string {
  const labelMap: Record<EntityType, { zh: string; en: string }> = {
    concept: { zh: '概念', en: 'Concept' },
    entity: { zh: '实体', en: 'Entity' },
    event: { zh: '事件', en: 'Event' },
    person: { zh: '人物', en: 'Person' },
    place: { zh: '地点', en: 'Place' },
    organization: { zh: '组织', en: 'Organization' },
    technology: { zh: '技术', en: 'Technology' },
  };
  return isZh ? labelMap[entityType]?.zh : labelMap[entityType]?.en;
}

function isDarkSkin(skinId: string): boolean {
  return skinId === 'default' || skinId === 'hub';
}

// ========== Custom Node Component ==========

function KGNodeComponent({ data, selected }: NodeProps<KGFlowNode>) {
  const { skin } = useSkin();
  const dark = isDarkSkin(skin);
  const accent = skin === 'hub' ? '#ff6b00' : skin === 'dream' ? '#e88c9a' : '#7c6cf0';
  const color = getEntityColor(data.entityType, accent, dark);
  const radius = 18 + Math.min(data.weight * 3, 20);

  const textColor = skin === 'hub' ? '#e0e0e0' : skin === 'dream' ? '#6c474d' : '#f0f6fc';
  const textSecondaryColor = skin === 'hub' ? '#888888' : skin === 'dream' ? '#a88a8f' : '#8b949e';
  const bgSecondary = skin === 'hub' ? '#121212' : skin === 'dream' ? '#ffffff' : '#161b22';
  const borderColor = skin === 'hub' ? '#2a2a2a' : skin === 'dream' ? '#f7dee2' : '#30363d';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        cursor: 'pointer',
        transition: 'opacity 0.2s',
      }}
    >
      {/* React Flow handles for edge connections */}
      <Handle type="target" position={Position.Top} style={{ opacity: 0, width: 1, height: 1 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0, width: 1, height: 1 }} />
      <Handle type="target" position={Position.Left} style={{ opacity: 0, width: 1, height: 1 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0, width: 1, height: 1 }} />

      {/* Node circle */}
      <div
        style={{
          width: radius * 2,
          height: radius * 2,
          borderRadius: '50%',
          background: `radial-gradient(circle at 35% 35%, ${color}, ${dark ? color + 'cc' : color + 'dd'})`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: `${radius * 0.7}px`,
          border: `${selected ? 3 : 1.5}px solid ${selected ? '#ffffff' : (dark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)')}`,
          boxShadow: selected ? `0 0 20px ${color}88` : 'none',
          userSelect: 'none',
        }}
      >
        {getEntityIcon(data.entityType)}
      </div>

      {/* Node label */}
      <div
        style={{
          marginTop: '4px',
          padding: '1px 6px',
          borderRadius: '4px',
          background: dark ? 'rgba(14,15,15,0.7)' : 'rgba(255,255,255,0.7)',
          color: textColor,
          fontSize: 'var(--fs-sm)',
          fontWeight: selected ? 600 : 400,
          maxWidth: '120px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          textAlign: 'center',
        }}
      >
        {data.label}
      </div>
    </div>
  );
}

// ========== Custom Edge Component ==========

function KGEdgeComponent({ id, sourceX, sourceY, targetX, targetY, data, selected }: EdgeProps<KGFlowEdge>) {
  const { skin } = useSkin();
  const dark = isDarkSkin(skin);
  const accent = skin === 'hub' ? '#ff6b00' : skin === 'dream' ? '#e88c9a' : '#7c6cf0';

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, targetX, targetY,
  });

  const textSecondaryColor = skin === 'hub' ? '#888888' : skin === 'dream' ? '#a88a8f' : '#8b949e';
  const bgSecondary = skin === 'hub' ? '#121212' : skin === 'dream' ? '#ffffff' : '#161b22';

  return (
    <>
      <path
        id={id}
        d={edgePath}
        stroke={selected ? accent : (dark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)')}
        strokeWidth={selected ? 2.5 : 1.2}
        fill="none"
        style={{ transition: 'stroke 0.2s, stroke-width 0.2s' }}
      />
      {selected && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              background: dark ? 'rgba(26,28,28,0.9)' : 'rgba(255,255,255,0.9)',
              color: textSecondaryColor,
              padding: '2px 6px',
              borderRadius: '4px',
              fontSize: 'var(--fs-xs)',
              pointerEvents: 'none',
            }}
          >
            {data?.relationType}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

// ========== Auto Layout (simple circular + force) ==========

function autoLayout(nodes: GraphNode[], edges: GraphEdge[]): { nodes: KGFlowNode[]; edges: KGFlowEdge[] } {
  const centerX = 400;
  const centerY = 300;

  // Build adjacency for degree calculation
  const degreeMap = new Map<string, number>();
  for (const e of edges) {
    degreeMap.set(e.sourceNodeId, (degreeMap.get(e.sourceNodeId) || 0) + 1);
    degreeMap.set(e.targetNodeId, (degreeMap.get(e.targetNodeId) || 0) + 1);
  }

  // Sort by degree (higher degree = more central)
  const sorted = [...nodes].sort((a, b) => (degreeMap.get(b.id) || 0) - (degreeMap.get(a.id) || 0));

  const flowNodes: KGFlowNode[] = sorted.map((node, i) => {
    const angle = (i / Math.max(nodes.length, 1)) * Math.PI * 2;
    const radius = 150 + (i === 0 ? 0 : 50 + Math.random() * 100);
    return {
      id: node.id,
      type: 'kgNode',
      position: { x: centerX + Math.cos(angle) * radius, y: centerY + Math.sin(angle) * radius },
      data: {
        label: node.label,
        entityType: node.entityType,
        weight: node.weight,
        description: node.description,
        communityId: node.communityId,
        sourceIds: node.sourceIds,
      },
    };
  });

  const flowEdges: KGFlowEdge[] = edges.map((e, i) => ({
    id: `e-${e.id || i}`,
    source: e.sourceNodeId,
    target: e.targetNodeId,
    type: 'kgEdge',
    data: { relationType: e.relationType },
  }));

  return { nodes: flowNodes, edges: flowEdges };
}

// ========== Main Component ==========

const nodeTypes = { kgNode: KGNodeComponent };
const edgeTypes = { kgEdge: KGEdgeComponent };

function KnowledgeGraphViewInner({ notebookId, onNodeSelect }: KnowledgeGraphViewProps) {
  const lang = useLang();
  const isZh = lang === 'zh';
  const { skin } = useSkin();

  const [loading, setLoading] = useState(false);
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], edges: [] });
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [extractError, setExtractError] = useState<string | null>(null);
  const [hasSources, setHasSources] = useState(false);

  // Editing state
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId?: string; edgeId?: string } | null>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState<KGFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<KGFlowEdge>([]);

  const reactFlowWrapper = useRef<HTMLDivElement>(null);

  // Skin-based styling
  const dark = isDarkSkin(skin);
  const bgColor = skin === 'hub' ? '#0a0a0a' : skin === 'dream' ? '#fdf5f7' : '#0d1117';
  const bgSecondary = skin === 'hub' ? '#121212' : skin === 'dream' ? '#ffffff' : '#161b22';
  const bgTertiary = skin === 'hub' ? '#1c1c1e' : skin === 'dream' ? '#fce8eb' : '#21262d';
  const textColor = skin === 'hub' ? '#e0e0e0' : skin === 'dream' ? '#6c474d' : '#f0f6fc';
  const textSecondaryColor = skin === 'hub' ? '#888888' : skin === 'dream' ? '#a88a8f' : '#8b949e';
  const borderColor = skin === 'hub' ? '#2a2a2a' : skin === 'dream' ? '#f7dee2' : '#30363d';
  const accentColor = skin === 'hub' ? '#ff6b00' : skin === 'dream' ? '#e88c9a' : '#7c6cf0';

  // Load graph data
  const loadGraph = useCallback(async () => {
    setLoading(true);
    setExtractError(null);
    try {
      const { listSources, getChunks } = await import('../core/knowledge');
      const sources = listSources(notebookId);
      setHasSources(sources.filter(s => s.status === 'indexed').length > 0);

      const existing = getGraphData(notebookId);
      if (existing.nodes.length > 0) {
        setGraphData(existing);
        const { nodes: fn, edges: fe } = autoLayout(existing.nodes, existing.edges);
        setNodes(fn);
        setEdges(fe);
      } else {
        const chunks = getChunks(notebookId);
        if (chunks.length === 0) {
          setGraphData({ nodes: [], edges: [] });
        } else {
          const { extractKnowledgeGraph } = await import('../core/knowledge');
          const data = await extractKnowledgeGraph(notebookId);
          setGraphData(data);
          const { nodes: fn, edges: fe } = autoLayout(data.nodes, data.edges);
          setNodes(fn);
          setEdges(fe);
          if (data.nodes.length === 0) {
            setExtractError(isZh ? 'LLM 提取失败，请检查 API 配置后重试' : 'LLM extraction failed. Check API config and retry.');
          }
        }
      }
    } catch (e) {
      console.error('Failed to load graph:', e);
      setExtractError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [notebookId, isZh, setNodes, setEdges]);

  useEffect(() => {
    loadGraph();
  }, [loadGraph]);

  // Highlight/dim based on search and selection
  useEffect(() => {
    if (!searchQuery && !selectedNode) {
      // Reset all nodes to full opacity
      setNodes(nds => nds.map(n => ({ ...n, opacity: 1 })));
      return;
    }

    const highlightId = selectedNode?.id;
    const connectedIds = new Set<string>();
    if (highlightId) {
      for (const e of graphData.edges) {
        if (e.sourceNodeId === highlightId) connectedIds.add(e.targetNodeId);
        if (e.targetNodeId === highlightId) connectedIds.add(e.sourceNodeId);
      }
    }

    setNodes(nds => nds.map(n => {
      const isMatch = searchQuery && n.data.label.toLowerCase().includes(searchQuery.toLowerCase());
      const isHighlighted = highlightId === n.id || connectedIds.has(n.id) || isMatch;
      return { ...n, opacity: isHighlighted || (!searchQuery && !highlightId) ? 1 : 0.25 };
    }));
  }, [searchQuery, selectedNode, graphData.edges, setNodes]);

  // Node click handler
  const onNodeClick = useCallback((_: React.MouseEvent, node: KGFlowNode) => {
    const original = graphData.nodes.find(n => n.id === node.id);
    if (original) setSelectedNode(original);
  }, [graphData.nodes]);

  // Node double click — open source document
  const onNodeDoubleClick = useCallback((_: React.MouseEvent, node: KGFlowNode) => {
    const original = graphData.nodes.find(n => n.id === node.id);
    if (original) onNodeSelect?.(original);
  }, [graphData.nodes, onNodeSelect]);

  // Edge click — select edge
  const onEdgeClick = useCallback((_: React.MouseEvent, edge: KGFlowEdge) => {
    // Could show edge details, for now just keep context menu working
  }, []);

  // Context menu (right-click)
  const onNodeContextMenu = useCallback((e: React.MouseEvent, node: KGFlowNode) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, nodeId: node.id });
  }, []);

  const onPaneContextMenu = useCallback((e: MouseEvent | React.MouseEvent) => {
    e.preventDefault();
    setContextMenu(null);
  }, []);

  // Save edited node label
  const handleSaveEdit = () => {
    if (editingNodeId && editLabel.trim()) {
      updateGraphNode(editingNodeId, { label: editLabel.trim() });
      setEditingNodeId(null);
      loadGraph();
    }
  };

  const handleDeleteNode = (nodeId: string) => {
    deleteGraphNode(nodeId);
    setContextMenu(null);
    setSelectedNode(null);
    loadGraph();
  };

  const handleDeleteEdge = (edgeId: string) => {
    const graphEdge = graphData.edges.find(e => `e-${e.id}` === edgeId);
    if (graphEdge) {
      deleteGraphEdge(graphEdge.id);
      loadGraph();
    }
    setContextMenu(null);
  };

  // Export PNG — use React Flow's screenshot
  const handleExportPNG = () => {
    // React Flow doesn't have a built-in PNG export, but we can use the viewport
    const wrapper = reactFlowWrapper.current;
    if (!wrapper) return;
    // Use html2canvas-like approach via canvas
    const canvas = wrapper.querySelector('canvas.react-flow__edges') as HTMLCanvasElement;
    if (canvas) {
      const link = document.createElement('a');
      link.download = `knowledge-graph-${Date.now()}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    }
  };

  const handleExportJSON = () => {
    const data = { nodes: graphData.nodes, edges: graphData.edges, exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `knowledge-graph-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Connected nodes for sidebar
  const connectedNodes = useMemo(() => {
    if (!selectedNode) return [];
    return graphData.edges
      .filter(e => e.sourceNodeId === selectedNode.id || e.targetNodeId === selectedNode.id)
      .map(e => {
        const otherId = e.sourceNodeId === selectedNode.id ? e.targetNodeId : e.sourceNodeId;
        return graphData.nodes.find(n => n.id === otherId);
      })
      .filter((n): n is GraphNode => n !== undefined);
  }, [selectedNode, graphData]);

  // Loading state
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

  // Empty state
  if (graphData.nodes.length === 0) {
    return (
      <div className="kg-empty" style={{ background: bgColor, color: textSecondaryColor }}>
        <Share2 size={48} style={{ opacity: 0.3 }} />
        {extractError ? (
          <>
            <p style={{ color: 'var(--error)' }}>{extractError}</p>
            <button onClick={loadGraph} style={{ background: accentColor, color: '#fff' }} className="kg-retry-btn">
              {isZh ? '重新提取' : 'Extract Again'}
            </button>
          </>
        ) : !hasSources ? (
          <p>{isZh ? '暂无图谱数据，请先添加并索引来源' : 'No graph data. Add and index sources first.'}</p>
        ) : (
          <>
            <p>{isZh ? '正在提取知识图谱...' : 'Extracting knowledge graph...'}</p>
            <button onClick={loadGraph} style={{ background: accentColor, color: '#fff' }} className="kg-retry-btn">
              {isZh ? '重新提取' : 'Extract Again'}
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="kg-container" style={{ background: bgColor, color: textColor, height: '100%' }}>
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
          <button className="kg-tool-btn kg-refresh-btn" onClick={loadGraph} title={isZh ? '重新提取图谱' : 'Re-extract Graph'} style={{ color: accentColor }}>
            <Loader2 size={16} />
          </button>
          <button className="kg-tool-btn" onClick={handleExportPNG} title={isZh ? '导出为 PNG' : 'Export as PNG'}>
            <Download size={16} />
          </button>
          <button className="kg-tool-btn" onClick={handleExportJSON} title={isZh ? '导出为 JSON' : 'Export as JSON'} style={{ fontSize: 'var(--fs-xs)' }}>
            JSON
          </button>
        </div>
      </div>

      {/* React Flow Canvas + Sidebar */}
      <div className="kg-body" style={{ flex: 1, overflow: 'hidden' }}>
        <div ref={reactFlowWrapper} className="kg-canvas-wrapper" style={{ flex: 1, height: '100%' }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodeClick={onNodeClick}
            onNodeDoubleClick={onNodeDoubleClick}
            onEdgeClick={onEdgeClick}
            onNodeContextMenu={onNodeContextMenu}
            onPaneContextMenu={onPaneContextMenu}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.2}
            maxZoom={4}
            proOptions={{ hideAttribution: true }}
            style={{ background: bgColor }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color={dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'} />
            <Controls
              showInteractive={false}
              style={{ background: bgSecondary, border: `1px solid ${borderColor}`, borderRadius: '6px' }}
            />
            <MiniMap
              nodeColor={(node) => {
                const n = node as KGFlowNode;
                return getEntityColor(n.data?.entityType || 'concept', accentColor, dark);
              }}
              maskColor={dark ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.7)'}
              style={{ background: bgSecondary, border: `1px solid ${borderColor}` }}
            />
          </ReactFlow>
        </div>

        {/* Node Detail Sidebar */}
        {selectedNode && (
          <div className="kg-sidebar" style={{ background: bgSecondary, borderLeft: `1px solid ${borderColor}` }}>
            <div className="kg-sidebar-header" style={{ borderBottom: `1px solid ${borderColor}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: 'var(--fs-2xl)' }}>{getEntityIcon(selectedNode.entityType)}</span>
                <h3 style={{ color: accentColor, margin: 0 }}>{selectedNode.label}</h3>
              </div>
              <span className="kg-entity-badge" style={{ background: getEntityColor(selectedNode.entityType, accentColor, dark), color: '#fff', fontSize: 'var(--fs-xs)' }}>
                {getEntityLabel(selectedNode.entityType, isZh)}
              </span>
            </div>

            {selectedNode.description && (
              <div className="kg-detail-section">
                <h4 style={{ color: textSecondaryColor, fontSize: 'var(--fs-sm)' }}>{isZh ? '描述' : 'Description'}</h4>
                <p style={{ color: textColor, fontSize: 'var(--fs-base)' }}>{selectedNode.description}</p>
              </div>
            )}

            <div className="kg-detail-section">
              <h4 style={{ color: textSecondaryColor, fontSize: 'var(--fs-sm)' }}>{isZh ? '权重' : 'Weight'}</h4>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{ flex: 1, height: '4px', background: bgTertiary, borderRadius: '2px', overflow: 'hidden' }}>
                  <div style={{ width: `${Math.min(selectedNode.weight * 10, 100)}%`, height: '100%', background: accentColor, borderRadius: '2px' }} />
                </div>
                <span style={{ color: textColor, fontSize: 'var(--fs-sm)' }}>{selectedNode.weight}</span>
              </div>
            </div>

            <div className="kg-detail-section">
              <h4 style={{ color: textSecondaryColor, fontSize: 'var(--fs-sm)' }}>
                {isZh ? '关联实体' : 'Connected Entities'} ({connectedNodes.length})
              </h4>
              <div className="kg-connected-list">
                {connectedNodes.map((node) => (
                  <button
                    key={node.id}
                    className="kg-connected-item"
                    onClick={() => setSelectedNode(node)}
                    style={{ background: bgTertiary, border: `1px solid ${borderColor}`, color: textColor, fontSize: 'var(--fs-sm)' }}
                  >
                    <span style={{ fontSize: 'var(--fs-md)' }}>{getEntityIcon(node.entityType)}</span>
                    <span className="kg-connected-dot" style={{ background: getEntityColor(node.entityType, accentColor, dark) }} />
                    {node.label}
                  </button>
                ))}
              </div>
            </div>

            {selectedNode.sourceIds.length > 0 && (
              <div className="kg-detail-section">
                <h4 style={{ color: textSecondaryColor, fontSize: 'var(--fs-sm)' }}>
                  {isZh ? '来源' : 'Sources'} ({selectedNode.sourceIds.length})
                </h4>
                <p style={{ color: textSecondaryColor, fontSize: 'var(--fs-xs)' }}>
                  {isZh ? '该实体出现在多个来源中' : 'This entity appears in multiple sources'}
                </p>
              </div>
            )}

            {/* Edit actions */}
            <div className="kg-detail-section">
              <button
                onClick={() => { setEditingNodeId(selectedNode.id); setEditLabel(selectedNode.label); }}
                style={{ width: '100%', padding: '6px', marginBottom: '6px', background: bgTertiary, border: `1px solid ${borderColor}`, borderRadius: '6px', color: textColor, cursor: 'pointer', fontSize: 'var(--fs-sm)', display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'center' }}
              >
                <Edit3 size={12} />
                {isZh ? '编辑节点' : 'Edit Node'}
              </button>
              <button
                onClick={() => handleDeleteNode(selectedNode.id)}
                style={{ width: '100%', padding: '6px', background: 'transparent', border: `1px solid #ef444455`, borderRadius: '6px', color: '#ef4444', cursor: 'pointer', fontSize: 'var(--fs-sm)', display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'center' }}
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
          <div key={type} className="kg-legend-item" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ fontSize: 'var(--fs-sm)' }}>{getEntityIcon(type)}</span>
            <span className="kg-legend-dot" style={{ background: getEntityColor(type, accentColor, dark) }} />
            <span style={{ color: textSecondaryColor, fontSize: 'var(--fs-xs)' }}>{getEntityLabel(type, isZh)}</span>
          </div>
        ))}
        <div className="kg-legend-item" style={{ marginLeft: 'auto' }}>
          <span style={{ color: textSecondaryColor, fontSize: 'var(--fs-xs)' }}>
            {isZh ? '单击选中 · 双击打开文档 · 右键菜单' : 'Click to select · Double-click to open · Right-click for menu'}
          </span>
        </div>
      </div>

      {/* Inline node label editor */}
      {editingNodeId && (
        <div className="nb-dialog-overlay" onClick={() => setEditingNodeId(null)} style={{ background: 'transparent', pointerEvents: 'auto' }}>
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', background: bgSecondary, border: `1px solid ${borderColor}`, borderRadius: '8px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px', minWidth: '300px' }}
          >
            <label style={{ fontSize: 'var(--fs-sm)', color: textSecondaryColor }}>{isZh ? '编辑节点标签' : 'Edit Node Label'}</label>
            <input
              type="text"
              value={editLabel}
              onChange={(e) => setEditLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveEdit(); if (e.key === 'Escape') setEditingNodeId(null); }}
              autoFocus
              style={{ padding: '6px 8px', background: bgTertiary, border: `1px solid ${borderColor}`, borderRadius: '4px', color: textColor, fontSize: 'var(--fs-base)', outline: 'none' }}
            />
            <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
              <button onClick={() => setEditingNodeId(null)} style={{ padding: '4px 12px', background: 'transparent', border: `1px solid ${borderColor}`, borderRadius: '4px', color: textColor, cursor: 'pointer', fontSize: 'var(--fs-sm)' }}>
                {isZh ? '取消' : 'Cancel'}
              </button>
              <button onClick={handleSaveEdit} style={{ padding: '4px 12px', background: accentColor, border: 'none', borderRadius: '4px', color: '#fff', cursor: 'pointer', fontSize: 'var(--fs-sm)' }}>
                {isZh ? '保存' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Right-click context menu */}
      {contextMenu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onClick={() => setContextMenu(null)} onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }} />
          {createPortal(
            <div style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y, zIndex: 9999, background: bgSecondary, border: `1px solid ${borderColor}`, borderRadius: '6px', padding: '4px', boxShadow: '0 4px 12px rgba(0,0,0,0.3)', minWidth: '140px' }}>
              {contextMenu.nodeId && (
                <>
                  <button
                    onClick={() => { setEditingNodeId(contextMenu.nodeId!); const n = graphData.nodes.find(x => x.id === contextMenu.nodeId); if (n) setEditLabel(n.label); setContextMenu(null); }}
                    style={{ display: 'flex', alignItems: 'center', gap: '6px', width: '100%', padding: '6px 8px', background: 'transparent', border: 'none', color: textColor, cursor: 'pointer', fontSize: 'var(--fs-sm)', borderRadius: '4px', textAlign: 'left' }}
                  >
                    <Edit3 size={12} />
                    {isZh ? '编辑标签' : 'Edit Label'}
                  </button>
                  <div style={{ height: '1px', background: borderColor, margin: '2px 0' }} />
                  <button
                    onClick={() => handleDeleteNode(contextMenu.nodeId!)}
                    style={{ display: 'flex', alignItems: 'center', gap: '6px', width: '100%', padding: '6px 8px', background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 'var(--fs-sm)', borderRadius: '4px', textAlign: 'left' }}
                  >
                    <Trash2 size={12} />
                    {isZh ? '删除节点' : 'Delete Node'}
                  </button>
                </>
              )}
              {contextMenu.edgeId && (
                <button
                  onClick={() => handleDeleteEdge(contextMenu.edgeId!)}
                  style={{ display: 'flex', alignItems: 'center', gap: '6px', width: '100%', padding: '6px 8px', background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 'var(--fs-sm)', borderRadius: '4px', textAlign: 'left' }}
                >
                  <Trash2 size={12} />
                  {isZh ? '删除连线' : 'Delete Edge'}
                </button>
              )}
            </div>,
            document.body
          )}
        </>
      )}
    </div>
  );
}

export function KnowledgeGraphView(props: KnowledgeGraphViewProps) {
  return (
    <ReactFlowProvider>
      <KnowledgeGraphViewInner {...props} />
    </ReactFlowProvider>
  );
}