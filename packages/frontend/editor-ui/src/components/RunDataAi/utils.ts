import { type LlmTokenUsageData, type IAiDataContent, type INodeUi } from '@/Interface';
import {
	type IRunData,
	type INodeExecutionData,
	type ITaskData,
	type ITaskDataConnections,
	type NodeConnectionType,
	type Workflow,
	type INodeTypeDescription,
} from 'n8n-workflow';

export interface AIResult {
	node: INodeUi;
	runIndex: number;
	runData: ITaskData;
	data: IAiDataContent | undefined;
}

export interface TreeNode {
	parent?: TreeNode;
	node: INodeUi;
	type: INodeTypeDescription;
	runData: ITaskData;
	id: string;
	children: TreeNode[];
	depth: number;
	startTime: number;
	runIndex: number;
	consumedTokens: LlmTokenUsageData;
}

type NodeTypeGetter = (typeName: string) => INodeTypeDescription | null;

function createNode(
	parent: TreeNode | undefined,
	node: INodeUi,
	runData: ITaskData,
	currentDepth: number,
	runIndex: number,
	r: AIResult | undefined,
	children: TreeNode[],
	getTypeDescription: NodeTypeGetter,
): TreeNode[] {
	const type = getTypeDescription(node.type);

	return type
		? [
				{
					parent,
					node,
					type,
					runData,
					id: `${node.name}:${runIndex}`,
					depth: currentDepth,
					startTime: r?.data?.metadata?.startTime ?? 0,
					runIndex,
					children,
					consumedTokens: getConsumedTokens(r?.data),
				},
			]
		: [];
}

export function getTreeNodeData(
	node: INodeUi,
	runData: ITaskData,
	workflow: Workflow,
	aiData: AIResult[] | undefined,
	runIndex: number | undefined,
	getTypeDescription: NodeTypeGetter,
): TreeNode[] {
	return getTreeNodeDataRec(
		undefined,
		node,
		runData,
		0,
		workflow,
		aiData,
		runIndex,
		getTypeDescription,
	);
}

function getTreeNodeDataRec(
	parent: TreeNode | undefined,
	node: INodeUi,
	runData: ITaskData,
	currentDepth: number,
	workflow: Workflow,
	aiData: AIResult[] | undefined,
	runIndex: number | undefined,
	getTypeDescription: NodeTypeGetter,
): TreeNode[] {
	const connections = workflow.connectionsByDestinationNode[node.name];
	const resultData =
		aiData?.filter(
			(data) =>
				data.node.name === node.name && (runIndex === undefined || runIndex === data.runIndex),
		) ?? [];

	if (!connections) {
		return resultData.flatMap((d) =>
			createNode(parent, node, runData, currentDepth, d.runIndex, d, [], getTypeDescription),
		);
	}

	// Get the first level of children
	const connectedSubNodes = workflow.getParentNodes(node.name, 'ALL_NON_MAIN', 1);

	const treeNode = createNode(
		parent,
		node,
		runData,
		currentDepth,
		runIndex ?? 0,
		undefined,
		[],
		getTypeDescription,
	)[0];

	if (!treeNode) {
		return [];
	}

	const children = connectedSubNodes.flatMap((name) => {
		const childNode = workflow.getNode(name);

		if (!childNode) {
			return [];
		}

		// Only include sub-nodes which have data
		return (
			aiData
				?.filter(
					(data) =>
						data.node.name === name && (runIndex === undefined || data.runIndex === runIndex),
				)
				.flatMap((data) =>
					getTreeNodeDataRec(
						treeNode,
						childNode,
						data.runData,
						currentDepth + 1,
						workflow,
						aiData,
						data.runIndex,
						getTypeDescription,
					),
				) ?? []
		);
	});

	children.sort((a, b) => a.startTime - b.startTime);

	treeNode.children = children;

	if (resultData.length) {
		return resultData.flatMap((r) =>
			createNode(
				parent,
				node,
				r.runData,
				currentDepth,
				r.runIndex,
				r,
				children,
				getTypeDescription,
			),
		);
	}

	return [treeNode];
}

export function createAiData(
	nodeName: string,
	workflow: Workflow,
	getWorkflowResultDataByNodeName: (nodeName: string) => ITaskData[] | null,
): AIResult[] {
	const result: AIResult[] = [];
	const connectedSubNodes = workflow.getParentNodes(nodeName, 'ALL_NON_MAIN');

	connectedSubNodes.forEach((name) => {
		const nodeRunData = getWorkflowResultDataByNodeName(name) ?? [];

		nodeRunData.forEach((runData, index) => {
			const node = workflow.getNode(name);

			if (node) {
				const referenceData = {
					data: getReferencedData(runData, false, true)[0],
					node,
					runIndex: index,
					runData,
				};

				result.push(referenceData);
			}
		});
	});

	// Sort the data by start time
	result.sort((a, b) => {
		const aTime = a.data?.metadata?.startTime ?? 0;
		const bTime = b.data?.metadata?.startTime ?? 0;
		return aTime - bTime;
	});

	return result;
}

export function getReferencedData(
	taskData: ITaskData,
	withInput: boolean,
	withOutput: boolean,
): IAiDataContent[] {
	if (!taskData) {
		return [];
	}

	const returnData: IAiDataContent[] = [];

	function addFunction(data: ITaskDataConnections | undefined, inOut: 'input' | 'output') {
		if (!data) {
			return;
		}

		Object.keys(data).map((type) => {
			returnData.push({
				data: data[type][0],
				inOut,
				type: type as NodeConnectionType,
				metadata: {
					executionTime: taskData.executionTime,
					startTime: taskData.startTime,
					subExecution: taskData.metadata?.subExecution,
				},
			});
		});
	}

	if (withInput) {
		addFunction(taskData.inputOverride, 'input');
	}
	if (withOutput) {
		addFunction(taskData.data, 'output');
	}

	return returnData;
}

const emptyTokenUsageData: LlmTokenUsageData = {
	completionTokens: 0,
	promptTokens: 0,
	totalTokens: 0,
	isEstimate: false,
};

function addTokenUsageData(one: LlmTokenUsageData, another: LlmTokenUsageData): LlmTokenUsageData {
	return {
		completionTokens: one.completionTokens + another.completionTokens,
		promptTokens: one.promptTokens + another.promptTokens,
		totalTokens: one.totalTokens + another.totalTokens,
		isEstimate: one.isEstimate || another.isEstimate,
	};
}

export function getConsumedTokens(outputRun: IAiDataContent | undefined): LlmTokenUsageData {
	if (!outputRun?.data) {
		return emptyTokenUsageData;
	}

	const tokenUsage = outputRun.data.reduce<LlmTokenUsageData>(
		(acc: LlmTokenUsageData, curr: INodeExecutionData) => {
			const tokenUsageData = curr.json?.tokenUsage ?? curr.json?.tokenUsageEstimate;

			if (!tokenUsageData) return acc;

			return addTokenUsageData(acc, {
				...(tokenUsageData as Omit<LlmTokenUsageData, 'isEstimate'>),
				isEstimate: !!curr.json.tokenUsageEstimate,
			});
		},
		emptyTokenUsageData,
	);

	return tokenUsage;
}

export function getTotalConsumedTokens(...usage: LlmTokenUsageData[]): LlmTokenUsageData {
	return usage.reduce(addTokenUsageData, emptyTokenUsageData);
}

export function getSubtreeTotalConsumedTokens(treeNode: TreeNode): LlmTokenUsageData {
	return getTotalConsumedTokens(
		treeNode.consumedTokens,
		...treeNode.children.map(getSubtreeTotalConsumedTokens),
	);
}

export function formatTokenUsageCount(
	usage: LlmTokenUsageData,
	field: 'total' | 'prompt' | 'completion',
) {
	const count =
		field === 'total'
			? usage.totalTokens
			: field === 'completion'
				? usage.completionTokens
				: usage.promptTokens;

	return usage.isEstimate ? `~${count}` : count.toLocaleString();
}

export function createLogEntries(
	workflow: Workflow,
	runData: IRunData,
	getTypeDescription: NodeTypeGetter,
) {
	const runs = Object.entries(runData)
		.filter(([nodeName]) => workflow.getChildNodes(nodeName, 'ALL_NON_MAIN').length === 0)
		.flatMap(([nodeName, taskData]) => {
			const node = workflow.getNode(nodeName);

			return node ? taskData.map((task, runIndex) => ({ node, task, runIndex })) : [];
		})
		.toSorted((a, b) => {
			if (a.task.executionIndex !== undefined && b.task.executionIndex !== undefined) {
				return a.task.executionIndex - b.task.executionIndex;
			}

			return a.node.name === b.node.name
				? a.runIndex - b.runIndex
				: a.task.startTime - b.task.startTime;
		});

	return runs.flatMap(({ node, runIndex, task }) => {
		if (workflow.getParentNodes(node.name, 'ALL_NON_MAIN').length > 0) {
			return getTreeNodeData(
				node,
				task,
				workflow,
				createAiData(node.name, workflow, (name) => runData[name] ?? []),
				undefined,
				getTypeDescription,
			);
		}

		return getTreeNodeData(
			node,
			task,
			workflow,
			[
				{
					data: getReferencedData(task, false, true)[0],
					node,
					runData: task,
					runIndex,
				},
			],
			runIndex,
			getTypeDescription,
		);
	});
}
