package git

import "testing"

func TestParseRepoFullName(t *testing.T) {
	cases := []struct {
		name    string
		url     string
		want    string
		wantErr bool
	}{
		{"ssh with .git", "git@github.com:owner/repo.git", "owner/repo", false},
		{"ssh without .git", "git@github.com:owner/repo", "owner/repo", false},
		{"https with .git", "https://github.com/owner/repo.git", "owner/repo", false},
		{"https without .git", "https://github.com/owner/repo", "owner/repo", false},
		{"https hyphenated", "https://github.com/my-org/my-repo.git", "my-org/my-repo", false},
		{"invalid", "not-a-url", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseRepoFullName(tc.url)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error for %q, got %q", tc.url, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("ParseRepoFullName(%q) = %q, want %q", tc.url, got, tc.want)
			}
		})
	}
}

func TestMaxBufferBytes(t *testing.T) {
	env := func(m map[string]string) func(string) string {
		return func(k string) string { return m[k] }
	}
	if got := MaxBufferBytes(env(nil)); got != 64*1024*1024 {
		t.Errorf("default = %d, want %d", got, 64*1024*1024)
	}
	if got := MaxBufferBytes(env(map[string]string{"CLI_GIT_MAX_BUFFER_MB": "128"})); got != 128*1024*1024 {
		t.Errorf("128MB = %d, want %d", got, 128*1024*1024)
	}
	if got := MaxBufferBytes(env(map[string]string{"CLI_GIT_MAX_BUFFER_MB": "garbage"})); got != 64*1024*1024 {
		t.Errorf("invalid falls back = %d, want %d", got, 64*1024*1024)
	}
	if got := MaxBufferBytes(env(map[string]string{"CLI_GIT_MAX_BUFFER_MB": "0"})); got != 64*1024*1024 {
		t.Errorf("zero falls back = %d, want %d", got, 64*1024*1024)
	}
}
