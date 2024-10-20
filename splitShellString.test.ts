import { splitShellString } from './splitShellString';

test.each([
    ['a b c', ['a', 'b', 'c']],
    ['a b \\c', ['a', 'b', 'c']],
    ['a b c\\', ['a', 'b', 'c']],
    ['a "b c" d', ['a', 'b c', 'd']],
    ['a \\"b c" d', ['a', '"b', 'c d']],
    ["a 'b c' d", ['a', 'b c', 'd']],
    ["a 'b c\" d", ['a', 'b c" d']],
    ["a 'b c\"' d", ['a', 'b c"', 'd']],
    ["a 'b\" c' d\" e", ['a', 'b" c', 'd e']],
    ['ab"c d"e f', ['abc de', 'f']],
    ['ab\\ c d', ['ab c', 'd']],
    ["bash -c 'eval \"echo \\\"$$(cat ~/temp.yml)\\\"\" > ~/kong.yml && /docker-entrypoint.sh kong docker-start'", ['bash', '-c', 'eval "echo \\"$$(cat ~/temp.yml)\\"" > ~/kong.yml && /docker-entrypoint.sh kong docker-start']],
])('splitQuotedArgs(%s) should return %s', (input, expected) => {
    expect(splitShellString(input)).toEqual(expected);
}
);
