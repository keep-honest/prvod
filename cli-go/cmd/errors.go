package cmd

import "fmt"

// CodedError carries the process exit code the CLI should terminate with,
// replicating the discrete exit codes of the Node CLI (1 generic, 2 flag
// conflict, 3 diff missing/empty, 4 not a diff, 5/6/7 server diff errors).
type CodedError struct {
	Code int
	Err  error
}

func (e *CodedError) Error() string { return e.Err.Error() }
func (e *CodedError) Unwrap() error { return e.Err }

// coded builds a CodedError with a formatted message.
func coded(code int, format string, a ...any) *CodedError {
	return &CodedError{Code: code, Err: fmt.Errorf(format, a...)}
}
