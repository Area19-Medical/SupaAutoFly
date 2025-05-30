/**
 * Evaluates the substitution of an environment variable based on the provided operator and argument.
 *
 * @param key - The name of the environment variable.
 * @param value - The value of the environment variable, or undefined if it is not set.
 * @param flag - An optional flag that modifies the behavior of the substitution. If the flag is ":", empty values are treated as undefined.
 * @param op - The substitution operator. Supported operators are:
 *             - `-` : Use the argument if the value is undefined (or empty depending on `flag`).
 *             - `?` : Throw an error with the argument as the message if the value is undefined or empty.
 *             - `+` : Use the argument as replacement if the value is defined (and not empty depending on `flag`), otherwise substitute an empty string.
 * @param arg - The argument to use in the substitution, required if an operator is provided.
 * @returns The result of the substitution.
 * @throws Will throw an error if the operator is `?` and the value is undefined or empty, or if an invalid operator is provided.
 */
function evalSubstitution(key: string, value: string | undefined, flag: string | undefined, op: string | undefined, arg: string | undefined): string {
    if (op === undefined) {
        if (value === undefined) {
            console.warn(`Environment variable ${key} is not defined, substituting empty string`);
        }
        return value ?? '';
    }
    if (op !== undefined && arg === undefined) {
        throw new Error(`Unexpected: op=${op} but arg is undefined`);
    }
    // If flag is ":", empty values are treated as undefined
    const assertedValue = flag === ':' && value !== undefined && value.length === 0 ? undefined : value;
    if (op === '-') {
        return assertedValue ?? arg!;
    }
    if (op === '?') {
        if (assertedValue === undefined) {
            throw new Error(arg);
        }
        return assertedValue;
    }
    if (op === '+') {
        return assertedValue !== undefined ? arg! : '';
    }
    throw new Error(`Invalid substitution operator: ${flag ?? ''}${op}`);
}


/**
 * Expands environment variables in a given string.
 *
 * This function takes an input value, converts it to a string, and replaces
 * any environment variable placeholders with their corresponding values from
 * the environment. The placeholders follow the format `${VAR}` and support
 * additional operations such as default values and error handling.
 *
 * Supported operations:
 * - `${VAR}`: Replaces with the value of `VAR` (or an empty string if unset - with warning).
 * - `${VAR:-default}`: Uses `default` if `VAR` is not set or is empty.
 * - `${VAR:+alt}`: Uses `alt` if `VAR` is set and not empty.
 * - `${VAR:?err}`: Throws an error with message `err` if `VAR` is not set or is empty.
 * - `${VAR-default}`: Uses `default` if `VAR` is not set.
 * - `${VAR+alt}`: Uses `alt` if `VAR` is set, otherwise an empty string.
 * - `${VAR?err}`: Throws an error with message `err` if `VAR` is not set.
 *
 * See also: https://docs.docker.com/reference/compose-file/interpolation/
 *
 * @param value - The input value which may contain environment variable placeholders.
 * @returns The input string with environment variable placeholders expanded.
 */
export function expandEnvVars(value: unknown): string {
    const valueString = String(value);
    return valueString.replace(/(\$+)(?:{(.*?)})?/g, (_, dollars, substitution) => {
        if (dollars.length % 2 === 0)
            return '$'.repeat(dollars.length / 2) + (substitution === undefined ? '' : `{${substitution}}`);
        if (substitution === undefined)
            return '$'.repeat((dollars.length + 1) / 2);
        const pre = '$'.repeat((dollars.length - 1) / 2);
        const { key, flag, op, arg } = substitution.match(/(?<key>[^-+:?]+)(?:(?<flag>:)?(?<op>[-+?])(?<arg>.*))?/).groups;
        return pre + evalSubstitution(key, process.env[key], flag, op, arg);
    });
}
