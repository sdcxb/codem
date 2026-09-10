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

/**
 * 实体类型的着色 —— 这是**类别色板**（数据），不是状态色，所以用 --chart-cat-* 而不是语义色。
 * 之前这里按皮肤 id 在 JS 里挑 16 进制对（深浅各一套），等于把皮肤表抄进了组件；
 * 现在颜色回到令牌，皮肤/主题切换自动跟随。
 */
function getEntityColor(entityType: EntityType): string {
  const colorMap: Record<EntityType, string> = {
    concept: 'var(--accent)',
    entity: 'var(--chart-cat-1)',
    event: 'var(--chart-cat-2)',
    person: 'var(--chart-cat-3)',
    place: 'var(--chart-cat-4)',
    organization: 'var(--chart-cat-5)',
    technology: 'var(--chart-cat-6)',
  };
  return colorMap[entityType] || 'var(--accent)';
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

// ========== Custom Node Component ==========

function KGNodeComponent({ data, selected }: NodeProps<KGFlowNode>) {
  const color = getEntityColor(data.entityType);
  const radius = 18 + Math.min(data.weight * 3, 20);

  return (
    // 第 39 波：图谱节点此前不可聚焦 —— 键盘用户在节点间"走不过去"（不是焦点看不见，是到不了）。
    // 补 role/tabIndex + Enter/Space：按键时向节点元素派发一次 click，事件冒泡到 React Flow
    // 的节点外壳后会走与鼠标完全相同的选中路径（onNodeClick → setSelectedNode），
    // 因此不需要给节点 data 增加新字段。
    <div
      className="kg-node"
      role="button"
      tabIndex={0}
      aria-label={data.label}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          (e.currentTarget as HTMLElement).click();
        }
      }}
    >
      {/* React Flow handles for edge connections */}
      <Handle type="target" position={Position.Top} className="kg-node-handle" />
      <Handle type="source" position={Position.Bottom} className="kg-node-handle" />
      <Handle type="target" position={Position.Left} className="kg-node-handle" />
      <Handle type="source" position={Position.Right} className="kg-node-handle" />

      {/* Node circle — 半径/字号/类别色是真动态值，其余在 .kg-node-circle 里 */}
      <div
        className={`kg-node-circle ${selected ? 'is-selected' : ''}`}
        style={{
          width: radius * 2,
          height: radius * 2,
          color,
          ["--kg-node-font" as string]: `${radius * 0.7}px`,
        }}
      >
        {getEntityIcon(data.entityType)}
      </div>

      {/* Node label */}
      <div className={`kg-node-label ${selected ? 'is-selected' : ''}`}>
        {data.label}
      </div>
    </div>
  );
}

// ========== Custom Edge Component ==========

function KGEdgeComponent({ id, sourceX, sourceY, targetX, targetY, data, selected }: EdgeProps<KGFlowEdge>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, targetX, targetY,
  });

  return (
    <>
      <path
        id={id}
        d={edgePath}
        className="kg-edge-path"
        stroke={selected ? 'var(--accent)' : 'var(--border-primary)'}
        strokeWidth={selected ? 2.5 : 1.2}
        fill="none"
      />
      {selected && (
        <EdgeLabelRenderer>
          <div
            className="kg-edge-label"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
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
      <div className="kg-loading">
        <Loader2 size={24} className="spin kg-refresh-btn" />
        <span className="kg-source-hint">
          {isZh ? '正在提取知识图谱...' : 'Extracting knowledge graph...'}
        </span>
      </div>
    );
  }

  // Empty state
  if (graphData.nodes.length === 0) {
    return (
      <div className="kg-empty">
        <Share2 size={48} className="kg-empty-icon" />
        {extractError ? (
          <>
            <p className="kg-error-text">{extractError}</p>
            <button onClick={loadGraph} className="kg-retry-btn">
              {isZh ? '重新提取' : 'Extract Again'}
            </button>
          </>
        ) : !hasSources ? (
          <p>{isZh ? '暂无图谱数据，请先添加并索引来源' : 'No graph data. Add and index sources first.'}</p>
        ) : (
          <>
            <p>{isZh ? '正在提取知识图谱...' : 'Extracting knowledge graph...'}</p>
            <button onClick={loadGraph} className="kg-retry-btn">
              {isZh ? '重新提取' : 'Extract Again'}
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="kg-container">
      {/* Toolbar */}
      <div className="kg-toolbar">
        <div className="kg-search-wrapper">
          <Search size={14} className="kg-search-icon" />
          <input
            className="kg-search-input"
            placeholder={isZh ? '搜索节点...' : 'Search nodes...'}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <div className="kg-toolbar-actions">
          <button className="kg-tool-btn kg-refresh-btn" onClick={loadGraph} title={isZh ? '重新提取图谱' : 'Re-extract Graph'}>
            <Loader2 size={16} />
          </button>
          <button className="kg-tool-btn" onClick={handleExportPNG} title={isZh ? '导出为 PNG' : 'Export as PNG'}>
            <Download size={16} />
          </button>
          <button className="kg-tool-btn kg-export-btn" onClick={handleExportJSON} title={isZh ? '导出为 JSON' : 'Export as JSON'}>
            JSON
          </button>
        </div>
      </div>

      {/* React Flow Canvas + Sidebar */}
      <div className="kg-body">
        <div ref={reactFlowWrapper} className="kg-canvas-wrapper">
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
            className="kg-rf-canvas"
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border-primary)" />
            <Controls
              showInteractive={false}
              className="kg-rf-controls"
            />
            <MiniMap
              nodeColor={(node) => {
                const n = node as KGFlowNode;
                return getEntityColor(n.data?.entityType || 'concept');
              }}
              maskColor="color-mix(in srgb, var(--bg-primary) 70%, transparent)"
              className="kg-rf-minimap"
            />
          </ReactFlow>
        </div>

        {/* Node Detail Sidebar */}
        {selectedNode && (
          <div className="kg-sidebar">
            <div className="kg-sidebar-header">
              <div className="kg-sidebar-title-row">
                <span className="kg-entity-icon">{getEntityIcon(selectedNode.entityType)}</span>
                <h3 className="kg-sidebar-title">{selectedNode.label}</h3>
              </div>
              <span
                className="kg-entity-badge"
                style={{ background: getEntityColor(selectedNode.entityType) }}
              >
                {getEntityLabel(selectedNode.entityType, isZh)}
              </span>
            </div>

            {selectedNode.description && (
              <div className="kg-detail-section">
                <h4>{isZh ? '描述' : 'Description'}</h4>
                <p>{selectedNode.description}</p>
              </div>
            )}

            <div className="kg-detail-section">
              <h4>{isZh ? '权重' : 'Weight'}</h4>
              <div className="kg-weight-row">
                <div className="kg-weight-track">
                  <div
                    className="kg-weight-fill"
                    style={{ width: `${Math.min(selectedNode.weight * 10, 100)}%` }}
                  />
                </div>
                <span className="kg-weight-value">{selectedNode.weight}</span>
              </div>
            </div>

            <div className="kg-detail-section">
              <h4>
                {isZh ? '关联实体' : 'Connected Entities'} ({connectedNodes.length})
              </h4>
              <div className="kg-connected-list">
                {connectedNodes.map((node) => (
                  <button
                    key={node.id}
                    className="kg-connected-item"
                    onClick={() => setSelectedNode(node)}
                  >
                    <span className="kg-connected-icon">{getEntityIcon(node.entityType)}</span>
                    <span
                      className="kg-connected-dot"
                      style={{ background: getEntityColor(node.entityType) }}
                    />
                    {node.label}
                  </button>
                ))}
              </div>
            </div>

            {selectedNode.sourceIds.length > 0 && (
              <div className="kg-detail-section">
                <h4>
                  {isZh ? '来源' : 'Sources'} ({selectedNode.sourceIds.length})
                </h4>
                <p className="kg-source-hint">
                  {isZh ? '该实体出现在多个来源中' : 'This entity appears in multiple sources'}
                </p>
              </div>
            )}

            {/* Edit actions */}
            <div className="kg-detail-section">
              <button
                onClick={() => { setEditingNodeId(selectedNode.id); setEditLabel(selectedNode.label); }}
                className="kg-action-btn kg-action-btn--edit"
              >
                <Edit3 size={12} />
                {isZh ? '编辑节点' : 'Edit Node'}
              </button>
              <button
                onClick={() => handleDeleteNode(selectedNode.id)}
                className="kg-action-btn kg-action-btn--danger"
              >
                <Trash2 size={12} />
                {isZh ? '删除节点' : 'Delete Node'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="kg-legend">
        {(['concept', 'entity', 'event', 'person', 'place', 'organization', 'technology'] as EntityType[]).map(type => (
          <div key={type} className="kg-legend-item">
            <span className="kg-legend-icon">{getEntityIcon(type)}</span>
            <span
              className="kg-legend-dot"
              style={{ background: getEntityColor(type) }}
            />
            <span className="kg-legend-text">{getEntityLabel(type, isZh)}</span>
          </div>
        ))}
        <div className="kg-legend-item kg-legend-hint">
          <span className="kg-legend-text">
            {isZh ? '单击选中 · 双击打开文档 · 右键菜单' : 'Click to select · Double-click to open · Right-click for menu'}
          </span>
        </div>
      </div>

      {/* Inline node label editor */}
      {editingNodeId && (
        <div className="nb-dialog-overlay kg-edit-overlay" onClick={() => setEditingNodeId(null)}>
          <div
            onClick={(e) => e.stopPropagation()}
            className="kg-edit-dialog"
          >
            <label className="kg-edit-label">{isZh ? '编辑节点标签' : 'Edit Node Label'}</label>
            <input
              type="text"
              value={editLabel}
              onChange={(e) => setEditLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveEdit(); if (e.key === 'Escape') setEditingNodeId(null); }}
              autoFocus
              className="kg-edit-input"
            />
            <div className="kg-edit-actions">
              <button onClick={() => setEditingNodeId(null)} className="kg-edit-btn kg-edit-btn--ghost">
                {isZh ? '取消' : 'Cancel'}
              </button>
              <button onClick={handleSaveEdit} className="kg-edit-btn kg-edit-btn--primary">
                {isZh ? '保存' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Right-click context menu */}
      {contextMenu && (
        <>
          <div className="popover-shield" style={{ zIndex: "var(--z-context-menu)" }} onClick={() => setContextMenu(null)} onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }} />
          {createPortal(
            <div className="popover-shell kg-menu" style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y, zIndex: "var(--z-context-menu-top)" }}>
              {contextMenu.nodeId && (
                <>
                  <button
                    onClick={() => { setEditingNodeId(contextMenu.nodeId!); const n = graphData.nodes.find(x => x.id === contextMenu.nodeId); if (n) setEditLabel(n.label); setContextMenu(null); }}
                    className="kg-menu-item"
                  >
                    <Edit3 size={12} />
                    {isZh ? '编辑标签' : 'Edit Label'}
                  </button>
                  <div className="kg-menu-sep" />
                  <button
                    onClick={() => handleDeleteNode(contextMenu.nodeId!)}
                    className="kg-menu-item kg-menu-item--danger"
                  >
                    <Trash2 size={12} />
                    {isZh ? '删除节点' : 'Delete Node'}
                  </button>
                </>
              )}
              {contextMenu.edgeId && (
                <button
                  onClick={() => handleDeleteEdge(contextMenu.edgeId!)}
                  className="kg-menu-item kg-menu-item--danger"
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