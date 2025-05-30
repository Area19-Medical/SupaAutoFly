import { expandEnvVars } from "./expandEnvVars";

describe("expandEnvVars", () => {
  beforeEach(() => {
    process.env.TEST_VAR = "testValue";
    process.env.EMPTY_VAR = "";
    delete process.env.UNSET_VAR;
  });

  it("should replace ${VAR} with the value of VAR", () => {
    expect(expandEnvVars("Value is ${TEST_VAR}")).toBe("Value is testValue");
  });

  it("should replace ${VAR:-default} with the default value if VAR is not set or empty", () => {
    expect(expandEnvVars("Value is ${TEST_VAR:-defaultValue}")).toBe(
      "Value is testValue"
    );
    expect(expandEnvVars("Value is ${UNSET_VAR:-defaultValue}")).toBe(
      "Value is defaultValue"
    );
    expect(expandEnvVars("Value is ${EMPTY_VAR:-defaultValue}")).toBe(
      "Value is defaultValue"
    );
  });

  it("should replace ${VAR:+alt} with alt if VAR is set and not empty", () => {
    expect(expandEnvVars("Value is ${TEST_VAR:+altValue}")).toBe(
      "Value is altValue"
    );
    expect(expandEnvVars("Value is ${EMPTY_VAR:+altValue}")).toBe("Value is ");
    expect(expandEnvVars("Value is ${UNSET_VAR:+altValue}")).toBe("Value is ");
  });

  it("should throw an error with message err if ${VAR:?err} and VAR is not set or empty", () => {
    expect(expandEnvVars("Value is ${TEST_VAR:?errorMessage}")).toBe(
      "Value is testValue"
    );
    expect(() => expandEnvVars("Value is ${UNSET_VAR:?errorMessage}")).toThrow(
      "errorMessage"
    );
    expect(() => expandEnvVars("Value is ${EMPTY_VAR:?errorMessage}")).toThrow(
      "errorMessage"
    );
  });

  it("should replace ${VAR-default} with the default value if VAR is not set", () => {
    expect(expandEnvVars("Value is ${TEST_VAR-defaultValue}")).toBe(
      "Value is testValue"
    );
    expect(expandEnvVars("Value is ${UNSET_VAR-defaultValue}")).toBe(
      "Value is defaultValue"
    );
    expect(expandEnvVars("Value is ${EMPTY_VAR-defaultValue}")).toBe(
      "Value is "
    );
  });

  it("should replace ${VAR+alt} with alt if VAR is set", () => {
    expect(expandEnvVars("Value is ${TEST_VAR+altValue}")).toBe(
      "Value is altValue"
    );
    expect(expandEnvVars("Value is ${EMPTY_VAR+altValue}")).toBe(
      "Value is altValue"
    );
    expect(expandEnvVars("Value is ${UNSET_VAR+altValue}")).toBe("Value is ");
  });

  it("should throw an error with message err if ${VAR?err} and VAR is not set", () => {
    expect(expandEnvVars("Value is ${TEST_VAR?errorMessage}")).toBe(
      "Value is testValue"
    );
    expect(expandEnvVars("Value is ${EMPTY_VAR?errorMessage}")).toBe(
      "Value is "
    );
    expect(() => expandEnvVars("Value is ${UNSET_VAR?errorMessage}")).toThrow(
      "errorMessage"
    );
  });

  it("should handle multiple environment variable substitutions in a single string", () => {
    expect(
      expandEnvVars("Values are ${TEST_VAR} and ${UNSET_VAR:-defaultValue}")
    ).toBe("Values are testValue and defaultValue");
  });

  it("should handle escaped dollar signs correctly", () => {
    expect(expandEnvVars("Value is $$${TEST_VAR}")).toBe("Value is $testValue");
    expect(expandEnvVars("Value is $${TEST_VAR}")).toBe("Value is ${TEST_VAR}");
    expect(expandEnvVars("Value is $$$$")).toBe("Value is $$");
    expect(expandEnvVars("Value is $$$")).toBe("Value is $$");
  });
});
