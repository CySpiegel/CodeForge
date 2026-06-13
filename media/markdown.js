// Markdown -> DOM renderer for the CodeForge webview: a small block/inline markdown parser plus a
// regex-based syntax highlighter. Pure (string + DOM only, no app state), so it lives in its own file
// loaded BEFORE main.js and exposes only renderMarkdown on window.CodeForge. There is no build step for
// media/ — keep this valid browser JS.
(function () {
  function renderMarkdown(container, text) {
    if (!container) {
      return;
    }

    const fragment = document.createDocumentFragment();
    const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
    let index = 0;
    let paragraph = [];

    function flushParagraph() {
      if (paragraph.length === 0) {
        return;
      }
      const p = document.createElement("p");
      appendInline(p, paragraph.join("\n"));
      fragment.append(p);
      paragraph = [];
    }

    while (index < lines.length) {
      const line = lines[index];

      if (!line.trim()) {
        flushParagraph();
        index++;
        continue;
      }

      const fence = line.match(/^\s*```([A-Za-z0-9_.-]+)?\s*$/);
      if (fence) {
        flushParagraph();
        index++;
        const codeLines = [];
        while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
          codeLines.push(lines[index]);
          index++;
        }
        if (index < lines.length) {
          index++;
        }
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        renderCodeBlock(code, codeLines.join("\n"), fence[1] || "");
        pre.append(code);
        fragment.append(pre);
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        flushParagraph();
        const level = Math.min(6, heading[1].length + 2);
        const h = document.createElement(`h${level}`);
        appendInline(h, heading[2]);
        fragment.append(h);
        index++;
        continue;
      }

      if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
        flushParagraph();
        fragment.append(document.createElement("hr"));
        index++;
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        flushParagraph();
        const quoteLines = [];
        while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
          quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
          index++;
        }
        const blockquote = document.createElement("blockquote");
        appendInline(blockquote, quoteLines.join("\n"));
        fragment.append(blockquote);
        continue;
      }

      const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (unordered || ordered) {
        flushParagraph();
        const list = document.createElement(unordered ? "ul" : "ol");
        while (index < lines.length) {
          const itemMatch = unordered
            ? lines[index].match(/^\s*[-*+]\s+(.+)$/)
            : lines[index].match(/^\s*\d+[.)]\s+(.+)$/);
          if (!itemMatch) {
            break;
          }
          const li = document.createElement("li");
          appendInline(li, itemMatch[1]);
          list.append(li);
          index++;
        }
        fragment.append(list);
        continue;
      }

      paragraph.push(line);
      index++;
    }

    flushParagraph();
    container.replaceChildren(fragment);
  }

  function appendInline(parent, text) {
    const pattern = /(`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*([^*\s][^*]*?)\*|_([^_\s][^_]*?)_)/g;
    let cursor = 0;
    let match;

    while ((match = pattern.exec(text)) !== null) {
      appendText(parent, text.slice(cursor, match.index));
      if (match[2] !== undefined) {
        const code = document.createElement("code");
        code.textContent = match[2];
        parent.append(code);
      } else if (match[3] !== undefined || match[4] !== undefined) {
        const strong = document.createElement("strong");
        appendInline(strong, match[3] ?? match[4]);
        parent.append(strong);
      } else if (match[5] !== undefined && match[6] !== undefined) {
        const link = document.createElement("a");
        link.href = match[6];
        link.textContent = match[5];
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        parent.append(link);
      } else {
        const em = document.createElement("em");
        appendInline(em, match[7] ?? match[8]);
        parent.append(em);
      }
      cursor = match.index + match[0].length;
    }

    appendText(parent, text.slice(cursor));
  }

  function appendText(parent, text) {
    const parts = String(text || "").split("\n");
    parts.forEach((part, index) => {
      if (index > 0) {
        parent.append(document.createElement("br"));
      }
      if (part) {
        parent.append(document.createTextNode(part));
      }
    });
  }

  function renderCodeBlock(code, source, language) {
    const normalized = normalizeLanguage(language);
    if (normalized) {
      code.dataset.language = normalized;
      code.className = `language-${normalized}`;
    }
    code.replaceChildren(highlightCode(source, normalized));
  }

  function highlightCode(source, language) {
    if (language === "diff" || language === "patch") {
      return highlightDiff(source);
    }
    if (language === "json" || language === "jsonc") {
      return highlightWithRules(source, [
        tokenRule("comment", "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/"),
        tokenRule("property", "\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"(?=\\s*:)"),
        tokenRule("string", "\"(?:\\\\[\\s\\S]|[^\"\\\\])*\""),
        tokenRule("number", "-?\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b"),
        tokenRule("keyword", "\\b(?:true|false|null)\\b"),
        tokenRule("punctuation", "[{}\\[\\],:]")
      ]);
    }
    if (language === "html" || language === "xml" || language === "svg") {
      return highlightWithRules(source, [
        tokenRule("comment", "<!--[\\s\\S]*?-->"),
        tokenRule("tag", "<\\/?[A-Za-z][^>\\n]*?>"),
        tokenRule("string", "\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|'(?:\\\\[\\s\\S]|[^'\\\\])*'")
      ]);
    }
    if (language === "css" || language === "scss" || language === "less") {
      return highlightWithRules(source, [
        tokenRule("comment", "\\/\\*[\\s\\S]*?\\*\\/"),
        tokenRule("string", "\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|'(?:\\\\[\\s\\S]|[^'\\\\])*'"),
        tokenRule("property", "\\b-?[A-Za-z][\\w-]*(?=\\s*:)"),
        tokenRule("number", "-?\\b\\d+(?:\\.\\d+)?(?:[a-zA-Z%]+)?\\b"),
        tokenRule("selector", "[.#][A-Za-z_-][\\w-]*"),
        tokenRule("keyword", "\\b(?:important|inherit|initial|unset|revert|var|calc|rgb|rgba|hsl|hsla)\\b"),
        tokenRule("punctuation", "[{}():;,]")
      ]);
    }
    if (language === "sh" || language === "bash" || language === "shell" || language === "zsh") {
      return highlightWithRules(source, [
        tokenRule("comment", "#[^\\n]*"),
        tokenRule("string", "\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|'(?:\\\\[\\s\\S]|[^'\\\\])*'"),
        tokenRule("keyword", "\\b(?:if|then|else|elif|fi|for|while|do|done|case|esac|function|in|export|local|return|set|unset)\\b"),
        tokenRule("variable", "\\$\\{?[A-Za-z_][\\w]*\\}?|\\$\\d+"),
        tokenRule("number", "\\b\\d+\\b"),
        tokenRule("operator", "[|&;()<>]")
      ]);
    }
    if (language === "py" || language === "python") {
      return highlightWithRules(source, commonCodeRules("\\b(?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield)\\b", true));
    }
    if (language === "go") {
      return highlightWithRules(source, commonCodeRules("\\b(?:break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var)\\b", false));
    }
    if (language === "rs" || language === "rust") {
      return highlightWithRules(source, commonCodeRules("\\b(?:as|async|await|break|const|continue|crate|dyn|else|enum|extern|false|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|true|type|unsafe|use|where|while)\\b", false));
    }
    if (language === "cs" || language === "csharp") {
      return highlightWithRules(source, commonCodeRules("\\b(?:abstract|as|async|await|base|bool|break|case|catch|class|const|continue|decimal|default|delegate|do|double|else|enum|event|explicit|extern|false|finally|fixed|float|for|foreach|get|if|implicit|in|int|interface|internal|is|lock|namespace|new|null|object|operator|out|override|private|protected|public|readonly|record|ref|required|return|sealed|set|static|string|struct|switch|this|throw|true|try|typeof|using|var|virtual|void|while|with|yield)\\b", false));
    }
    return highlightWithRules(source, commonCodeRules("\\b(?:abstract|as|async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|false|finally|for|from|function|get|if|implements|import|in|instanceof|interface|let|new|null|of|package|private|protected|public|readonly|return|set|static|super|switch|this|throw|true|try|type|typeof|undefined|var|void|while|with|yield)\\b", false));
  }

  function commonCodeRules(keywordPattern, hashComments) {
    return [
      tokenRule("comment", `${hashComments ? "#[^\\n]*|" : ""}\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/`),
      tokenRule("string", "\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|'(?:\\\\[\\s\\S]|[^'\\\\])*'|`(?:\\\\[\\s\\S]|[^`\\\\])*`"),
      tokenRule("keyword", keywordPattern),
      tokenRule("number", "\\b(?:0x[\\da-fA-F]+|\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b"),
      tokenRule("function", "\\b[A-Za-z_$][\\w$]*(?=\\s*\\()"),
      tokenRule("type", "\\b[A-Z][A-Za-z0-9_]*\\b"),
      tokenRule("operator", "[{}\\[\\]().,;:+\\-*/%=&|!<>?~^]+")
    ];
  }

  function tokenRule(className, pattern) {
    return { className, pattern };
  }

  function highlightWithRules(source, rules) {
    const fragment = document.createDocumentFragment();
    const pattern = new RegExp(rules.map((rule) => `(${rule.pattern})`).join("|"), "g");
    let cursor = 0;
    let match;

    while ((match = pattern.exec(source)) !== null) {
      if (match.index < cursor) {
        continue;
      }
      appendPlainCode(fragment, source.slice(cursor, match.index));
      const ruleIndex = match.slice(1).findIndex((value) => value !== undefined);
      const className = rules[ruleIndex]?.className;
      appendCodeToken(fragment, match[0], className);
      cursor = pattern.lastIndex;
      if (pattern.lastIndex === match.index) {
        pattern.lastIndex++;
      }
    }

    appendPlainCode(fragment, source.slice(cursor));
    return fragment;
  }

  function highlightDiff(source) {
    const fragment = document.createDocumentFragment();
    const lines = source.match(/[^\n]*(?:\n|$)/g) || [];
    for (const line of lines) {
      if (!line) {
        continue;
      }
      const className = line.startsWith("@@")
        ? "hunk"
        : line.startsWith("+") && !line.startsWith("+++")
          ? "inserted"
          : line.startsWith("-") && !line.startsWith("---")
            ? "deleted"
            : line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("+++") || line.startsWith("---")
              ? "meta"
              : "";
      appendCodeToken(fragment, line, className);
    }
    return fragment;
  }

  function appendCodeToken(parent, text, className) {
    if (!text) {
      return;
    }
    if (!className) {
      appendPlainCode(parent, text);
      return;
    }
    const span = document.createElement("span");
    span.className = `syntax-${className}`;
    span.textContent = text;
    parent.append(span);
  }

  function appendPlainCode(parent, text) {
    if (text) {
      parent.append(document.createTextNode(text));
    }
  }

  function normalizeLanguage(language) {
    const normalized = String(language || "").trim().toLowerCase();
    const aliases = {
      cjs: "js",
      htm: "html",
      javascript: "js",
      jsx: "js",
      mjs: "js",
      shellsession: "shell",
      text: "",
      tsx: "ts",
      typescript: "ts",
      yml: "yaml"
    };
    return aliases[normalized] ?? normalized;
  }

  window.CodeForge = window.CodeForge || {};
  window.CodeForge.renderMarkdown = renderMarkdown;
}());
