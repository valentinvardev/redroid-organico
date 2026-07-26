#!/usr/bin/env python3
"""Turns a uiautomator dump into a table of things a UI flow can target.

Reads the XML on stdin. `--all` keeps every node instead of only the ones with
an id, some text, or a description.
"""
import re
import sys

show_all = '--all' in sys.argv
xml = sys.stdin.read()

rows = []
for node in re.findall(r'<node\b[^>]*>', xml):
    def attr(name, _node=node):
        match = re.search(rf'{name}="([^"]*)"', _node)
        return match.group(1) if match else ''

    rid, text, desc = attr('resource-id'), attr('text'), attr('content-desc')
    klass = attr('class').split('.')[-1]
    clickable = attr('clickable') == 'true'

    # A node with no id, no text and no description cannot be targeted, and a
    # node nobody can touch is rarely what a flow is waiting for.
    if not show_all and not (rid or text or desc):
        continue
    if not show_all and not clickable and not text and not rid:
        continue

    rows.append((rid, text, desc, klass, 'tap' if clickable else ''))

if not rows:
    print('Nothing targetable on this screen.', file=sys.stderr)
    sys.exit(1)

header = ('resource-id', 'text', 'content-desc', 'class', '')
widths = [min(60, max(len(row[i]) for row in rows + [header])) for i in range(5)]


def line(cols):
    return '  '.join(col[:60].ljust(width) for col, width in zip(cols, widths))


print(line(header))
print('  '.join('-' * width for width in widths))
for row in rows:
    print(line(row))

print(f'\n{len(rows)} targetable nodes.', file=sys.stderr)
print('resource-id -> using "id"; content-desc -> using "accessibility id".', file=sys.stderr)
