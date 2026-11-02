package cloud.clever.observatory;

import java.util.List;
import org.bson.Document;

/** Reads the useful lines out of MongoDB's explain("executionStats") output. */
final class QueryPlan {

    private QueryPlan() {}

    static Document summarize(Document explain) {
        Document planner = explain.get("queryPlanner", Document.class);
        Document stats = explain.get("executionStats", Document.class);
        Document winning = planner == null ? null : planner.get("winningPlan", Document.class);

        Document index = findStage(winning, "IXSCAN");
        Document summary = new Document("stage", index != null ? "IXSCAN" : "COLLSCAN");
        if (index != null) {
            summary.append("index", index.getString("indexName"));
        }
        if (stats != null) {
            summary.append("docsExamined", stats.get("totalDocsExamined"))
                    .append("keysExamined", stats.get("totalKeysExamined"))
                    .append("serverMillis", stats.get("executionTimeMillis"));
        }
        return summary;
    }

    /** Depth-first search through inputStage / inputStages for a stage name. */
    private static Document findStage(Document stage, String name) {
        if (stage == null) {
            return null;
        }
        if (name.equals(stage.getString("stage"))) {
            return stage;
        }
        Document found = findStage(stage.get("inputStage", Document.class), name);
        if (found != null) {
            return found;
        }
        for (Document child : stage.getList("inputStages", Document.class, List.of())) {
            found = findStage(child, name);
            if (found != null) {
                return found;
            }
        }
        return null;
    }
}
