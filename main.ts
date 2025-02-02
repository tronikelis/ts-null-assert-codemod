import { Project, ts, Node, SyntaxKind, Diagnostic } from "ts-morph";
import * as path from "node:path";
import * as fs from "node:fs";

type TNode = Node<ts.Node>;

function traverseNode(node: TNode, cb: (node: TNode) => void) {
  cb(node);
  node.getChildren().forEach((node) => traverseNode(node, cb));
}

function findDeepestNode(
  root: TNode,
  where: (Node: TNode) => boolean,
): TNode | undefined {
  let current: TNode | undefined;

  traverseNode(root, (n) => {
    if (where(n)) {
      current = n;
    }
  });

  return current;
}

function isParentNonNull(node: TNode): boolean {
  return node.getParent()?.isKind(SyntaxKind.NonNullExpression) || false;
}

function appendBang(node: TNode): void {
  let nText = node.getText();
  const nHasSemi = nText.trim()[nText.trim().length - 1] === ";";

  if (nHasSemi) {
    nText = nText.substring(0, nText.length - 1) + "!" + ";";
  } else {
    nText += "!";
  }

  console.log("replacing", node.getText(), "->", nText);

  node.replaceWithText(nText);
}

// null assert priority
// 1. element access expression
// 2. return statement
// 3. identifier -> its value declaration
function fixDig<T extends TNode>(
  root: T,
  baseCond: (node: TNode) => boolean,
): boolean {
  const elemAccessNode = findDeepestNode(root, (n) => {
    if (!baseCond(n)) return false;
    if (n.isKind(SyntaxKind.ElementAccessExpression)) return true;
    return false;
  });

  if (elemAccessNode) {
    appendBang(elemAccessNode);
    return true;
  }

  const retStatement = findDeepestNode(root, (n) => {
    if (!baseCond(n)) return false;
    if (n.isKind(SyntaxKind.ReturnStatement)) return true;
    return false;
  });

  if (retStatement) {
    return false;
  }

  const identNode = findDeepestNode(root, (n) => {
    if (!baseCond(n)) return false;
    if (n.isKind(SyntaxKind.Identifier)) return true;
    return false;
  });

  if (identNode) {
    const cond = (n: TNode) => !isParentNonNull(n);

    const valueDec = identNode.getSymbol()?.getValueDeclaration();
    if (!valueDec) {
      // should i call appendBang here?
      console.warn("no valueDec on", identNode.getText());
      return false;
    }

    // bar: arr || jsx={foo}
    if (
      valueDec.isKind(SyntaxKind.PropertyAssignment) ||
      valueDec.isKind(SyntaxKind.JsxAttribute)
    ) {
      const initializer = valueDec.getInitializer();
      if (!initializer) {
        console.warn("no initializer on", valueDec.getText());
        return false;
      }

      return fixDig(initializer, cond);
    }

    // const {foo} = {foo}
    if (valueDec.isKind(SyntaxKind.BindingElement)) {
      appendBang(identNode);
      return true;
    }

    // fn parameter
    if (valueDec.isKind(SyntaxKind.Parameter)) {
      appendBang(identNode);
      return true;
    }

    // nice: nice!
    if (valueDec.isKind(SyntaxKind.ShorthandPropertyAssignment)) {
      const text = valueDec.getText();
      valueDec.replaceWithText(text + ": " + text + "!");
      return true;
    }

    return fixDig(valueDec, cond);
  }

  return false;
}

function findRootPath(startPath: string, target: string): string | undefined {
  startPath = path.resolve(startPath);

  try {
    const test = path.join(startPath, target);
    fs.statSync(test);
    return test;
  } catch {}

  const parent = startPath.split(path.sep);
  parent.pop();

  startPath = parent.join(path.sep);
  if (!startPath) return;

  return findRootPath(startPath, target);
}

async function main() {
  const tsConfigFilePath = process.argv[2] || "./tsconfig.json";
  const libFolderPath = findRootPath(
    tsConfigFilePath,
    "./node_modules/typescript/lib",
  );

  console.log({ tsConfigFilePath, libFolderPath });

  const project = new Project({
    tsConfigFilePath,
    libFolderPath,
  });

  let diagnostics = project.getPreEmitDiagnostics();

  const skippedDigs = new Set<string>();

  for (let i = 0; i < diagnostics.length; i++) {
    const dig = diagnostics[i]!;

    const start = dig.getStart();
    const filePath = dig.getSourceFile()?.getFilePath();

    const msgText = dig.getMessageText();
    const msg: string =
      typeof msgText === "string" ? msgText : msgText.getMessageText();

    const digHash = `${msg}${dig.getLineNumber()}${filePath}`;

    if (!msg.includes("undefined") || skippedDigs.has(digHash)) continue;

    console.log(`fixing ${dig.getLineNumber()} ${start}`, msg);

    let success = false;

    try {
      success = fixDig(
        dig.getSourceFile()!,
        (n) => n.getStart() === start && !isParentNonNull(n),
      );
    } catch (err) {
      console.log("CANT FIX", err);
      console.log(digHash);
    }

    if (!success) {
      skippedDigs.add(digHash);
      continue;
    }

    // jump to next file as we modified the diagnostics start so we can't
    // modify the same file again based on current diagnostics
    while (diagnostics[i + 1]?.getSourceFile()?.getFilePath() === filePath) {
      i++;
    }

    // we did 1 modification to every single file at this point, reset
    if (i === diagnostics.length - 2 || !diagnostics[i + 1]) {
      console.log("SAVING CHANGES!!!");
      await project.save();
      diagnostics = project.getPreEmitDiagnostics();
      i = 0;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
