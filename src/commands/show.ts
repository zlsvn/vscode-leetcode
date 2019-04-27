// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

import * as fse from "fs-extra";
import * as path from "path";
import * as unescapeJS from "unescape-js";
import * as vscode from "vscode";
import { LeetCodeNode } from "../explorer/LeetCodeNode";
import { leetCodeTreeDataProvider } from "../explorer/leetCodeTreeDataProvider";
import { leetCodeChannel } from "../leetCodeChannel";
import { leetCodeExecutor } from "../leetCodeExecutor";
import { leetCodeManager } from "../leetCodeManager";
import { IProblem, IQuickItemEx, languages, ProblemState } from "../shared";
import { DialogOptions, DialogType, promptForOpenOutputChannel, promptForSignIn } from "../utils/uiUtils";
import { getActiveFilePath, selectWorkspaceFolder } from "../utils/workspaceUtils";
import * as wsl from "../utils/wslUtils";
import { leetCodePreviewProvider } from "../webview/leetCodePreviewProvider";
import { leetCodeSolutionProvider } from "../webview/leetCodeSolutionProvider";
import * as list from "./list";

export async function previewProblem(source: IProblem | vscode.Uri | undefined, isSideMode: boolean = false): Promise<void> {
    try {
        let problem: IProblem;
        let descString: string;
        if (source && "difficulty" in source) {
            problem = source;
            descString = await leetCodeExecutor.getDescription(problem.id);
        } else {
            const filename: string = (await getActiveFilePath(source))!;
            const [meta, desc] = splitMetaOutput(await leetCodeExecutor.getDescription(filename));
            problem = leetCodeTreeDataProvider.getProblem(meta.id)!;
            descString = desc;
            isSideMode = true;
        }
        leetCodePreviewProvider.show(descString, problem, isSideMode);
    } catch (error) {
        leetCodeChannel.appendLine(error.toString());
        await promptForOpenOutputChannel("Failed to preview the problem. Please open the output channel for details.", DialogType.error);
    }
}

export async function showProblem(node?: LeetCodeNode): Promise<void> {
    if (!node) {
        return;
    }
    await showProblemInternal(node);
}

export async function searchProblem(): Promise<void> {
    if (!leetCodeManager.getUser()) {
        promptForSignIn();
        return;
    }
    const choice: IQuickItemEx<IProblem> | undefined = await vscode.window.showQuickPick(
        parseProblemsToPicks(list.listProblems()),
        {
            matchOnDetail: true,
            placeHolder: "Select one problem",
        },
    );
    if (!choice) {
        return;
    }
    await showProblemInternal(choice.value);
}

export async function showSolution(node?: LeetCodeNode): Promise<void> {
    if (!node) {
        return;
    }
    const language: string | undefined = await fetchProblemLanguage();
    if (!language) {
        return;
    }
    try {
        const solution: string = await leetCodeExecutor.showSolution(node, language);
        leetCodeSolutionProvider.show(unescapeJS(solution), node);
    } catch (error) {
        leetCodeChannel.appendLine(error.toString());
        await promptForOpenOutputChannel("Failed to fetch the top voted solution. Please open the output channel for details.", DialogType.error);
    }
}

// SUGGESTION: group config retriving into one file
async function fetchProblemLanguage(): Promise<string | undefined> {
    const leetCodeConfig: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("leetcode");
    let defaultLanguage: string | undefined = leetCodeConfig.get<string>("defaultLanguage");
    if (defaultLanguage && languages.indexOf(defaultLanguage) < 0) {
        defaultLanguage = undefined;
    }
    const language: string | undefined = defaultLanguage || await vscode.window.showQuickPick(languages, { placeHolder: "Select the language you want to use", ignoreFocusOut: true });
    // fire-and-forget default language query
    (async (): Promise<void> => {
        if (language && !defaultLanguage && leetCodeConfig.get<boolean>("showSetDefaultLanguageHint")) {
            const choice: vscode.MessageItem | undefined = await vscode.window.showInformationMessage(
                `Would you like to set '${language}' as your default language?`,
                DialogOptions.yes,
                DialogOptions.no,
                DialogOptions.never,
            );
            if (choice === DialogOptions.yes) {
                leetCodeConfig.update("defaultLanguage", language, true /* UserSetting */);
            } else if (choice === DialogOptions.never) {
                leetCodeConfig.update("showSetDefaultLanguageHint", false, true /* UserSetting */);
            }
        }
    })();
    return language;
}

async function showProblemInternal(node: IProblem): Promise<void> {
    try {
        const language: string | undefined = await fetchProblemLanguage();
        if (!language) {
            return;
        }

        // SUGGESTION: group config retriving into one file
        const leetCodeConfig: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("leetcode");
        let outDir: string = await selectWorkspaceFolder();
        let relativePath: string = (leetCodeConfig.get<string>("outputFolder", "")).trim();
        const matchResult: RegExpMatchArray | null = relativePath.match(/\$\{(.*?)\}/);
        if (matchResult) {
            const resolvedPath: string | undefined = await resolveRelativePath(matchResult[1].toLocaleLowerCase(), node, language);
            if (!resolvedPath) {
                leetCodeChannel.appendLine("Showing problem canceled by user.");
                return;
            }
            relativePath = resolvedPath;
        }

        outDir = path.join(outDir, relativePath);
        await fse.ensureDir(outDir);

        const originFilePath: string = await leetCodeExecutor.showProblem(node, language, outDir);
        const filePath: string = wsl.useWsl() ? await wsl.toWinPath(originFilePath) : originFilePath;
        await Promise.all([
            vscode.window.showTextDocument(vscode.Uri.file(filePath), { preview: false, viewColumn: vscode.ViewColumn.One }),
            movePreviewAsideIfNeeded(node),
        ]);
    } catch (error) {
        await promptForOpenOutputChannel("Failed to show the problem. Please open the output channel for details.", DialogType.error);
    }
}

async function movePreviewAsideIfNeeded(node: IProblem): Promise<void> {
    if (vscode.workspace.getConfiguration("leetcode").get<boolean>("enableSideMode", true)) {
        return previewProblem(node, true);
    } else {
        return Promise.resolve();
    }
}

async function parseProblemsToPicks(p: Promise<IProblem[]>): Promise<Array<IQuickItemEx<IProblem>>> {
    return new Promise(async (resolve: (res: Array<IQuickItemEx<IProblem>>) => void): Promise<void> => {
        const picks: Array<IQuickItemEx<IProblem>> = (await p).map((problem: IProblem) => Object.assign({}, {
            label: `${parseProblemDecorator(problem.state, problem.locked)}${problem.id}.${problem.name}`,
            description: "",
            detail: `AC rate: ${problem.passRate}, Difficulty: ${problem.difficulty}`,
            value: problem,
        }));
        resolve(picks);
    });
}

function splitMetaOutput(outputWithMeta: string): [{ id: string, lang: string }, string] {
    const [metaJSON, output] = outputWithMeta.split(/\n([^]+)/);
    return [JSON.parse(metaJSON), output];
}

function parseProblemDecorator(state: ProblemState, locked: boolean): string {
    switch (state) {
        case ProblemState.AC:
            return "$(check) ";
        case ProblemState.NotAC:
            return "$(x) ";
        default:
            return locked ? "$(lock) " : "";
    }
}

async function resolveRelativePath(value: string, node: IProblem, selectedLanguage: string): Promise<string | undefined> {
    switch (value) {
        case "tag":
            if (node.tags.length === 1) {
                return node.tags[0];
            }
            return await vscode.window.showQuickPick(
                node.tags,
                {
                    matchOnDetail: true,
                    placeHolder: "Multiple tags available, please select one",
                    ignoreFocusOut: true,
                },
            );
        case "language":
            return selectedLanguage;
        case "difficulty":
            return node.difficulty;
        default:
            const errorMsg: string = `The config '${value}' is not supported.`;
            leetCodeChannel.appendLine(errorMsg);
            throw new Error(errorMsg);
    }
}
