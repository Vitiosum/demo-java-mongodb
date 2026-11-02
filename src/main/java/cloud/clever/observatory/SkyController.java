package cloud.clever.observatory;

import static com.mongodb.client.model.Filters.eq;
import static com.mongodb.client.model.Filters.exists;

import com.mongodb.client.MongoCollection;
import com.mongodb.client.model.FindOneAndDeleteOptions;
import com.mongodb.client.model.Sorts;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.bson.Document;
import org.bson.json.JsonMode;
import org.bson.json.JsonWriterSettings;
import org.bson.types.ObjectId;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.validation.FieldError;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * The sky's JSON API. Every response is MongoDB Extended JSON (relaxed mode), so the
 * page shows documents exactly as the database returns them: ObjectId, dates, nesting.
 */
@RestController
@RequestMapping(value = "/api", produces = MediaType.APPLICATION_JSON_VALUE)
class SkyController {

    static final String COLLECTION = "sky";
    static final int MAX_VISITOR_DISCOVERIES = 40;
    private static final JsonWriterSettings RELAXED = JsonWriterSettings.builder().outputMode(JsonMode.RELAXED).build();

    private final MongoTemplate mongo;

    SkyController(MongoTemplate mongo) {
        this.mongo = mongo;
    }

    private MongoCollection<Document> sky() {
        return mongo.getCollection(COLLECTION);
    }

    /** Everything needed to draw the chart. */
    @GetMapping("/sky")
    String everything() {
        List<Document> objects = sky().find().into(new ArrayList<>());
        return json(new Document("objects", objects));
    }

    /** One object; for a constellation, also resolve its star references with $lookup. */
    @GetMapping("/objects/{id}")
    ResponseEntity<String> object(@PathVariable String id) {
        if (!ObjectId.isValid(id)) {
            return error(HttpStatus.NOT_FOUND, "No object has the id " + id + ".");
        }
        Document doc = sky().find(eq("_id", new ObjectId(id))).first();
        if (doc == null) {
            return error(HttpStatus.NOT_FOUND, "No object has the id " + id + ".");
        }
        Document out = new Document("document", doc);
        if ("constellation".equals(doc.getString("type"))) {
            List<Document> pipeline = List.of(
                    new Document("$match", new Document("_id", doc.getObjectId("_id"))),
                    new Document("$lookup", new Document("from", COLLECTION)
                            .append("localField", "stars").append("foreignField", "_id").append("as", "starDocs")),
                    new Document("$project", new Document("starDocs._id", 1).append("starDocs.name", 1)
                            .append("starDocs.bayer", 1).append("starDocs.magnitude", 1)));
            long start = System.nanoTime();
            Document joined = sky().aggregate(pipeline).first();
            out.append("lookup", new Document("pipeline", pipeline)
                    .append("millis", millisSince(start))
                    .append("stars", joined == null ? List.of() : joined.getList("starDocs", Document.class)));
        }
        return ResponseEntity.ok(json(out));
    }

    /** The query bar: plain words → filter document → find(), timed, with the server's plan. */
    @GetMapping("/query")
    ResponseEntity<String> query(@RequestParam(defaultValue = "") String q) {
        Document filter;
        try {
            filter = SkyQuery.parse(q);
        } catch (IllegalArgumentException e) {
            return error(HttpStatus.BAD_REQUEST, e.getMessage());
        }
        long start = System.nanoTime();
        List<Document> results = sky().find(filter).sort(Sorts.ascending("type", "name")).into(new ArrayList<>());
        double millis = millisSince(start);

        Document explain = mongo.getDb().runCommand(new Document("explain",
                new Document("find", COLLECTION).append("filter", filter)).append("verbosity", "executionStats"));

        return ResponseEntity.ok(json(new Document("query", q)
                .append("filter", filter)
                .append("count", results.size())
                .append("millis", millis)
                .append("plan", QueryPlan.summarize(explain))
                .append("results", results)));
    }

    /** Footer: how many documents of each type, with a $group aggregation. */
    @GetMapping("/census")
    String census() {
        List<Document> pipeline = List.of(
                new Document("$group", new Document("_id", "$type").append("count", new Document("$sum", 1))),
                new Document("$sort", new Document("count", -1).append("_id", 1)));
        long start = System.nanoTime();
        List<Document> groups = sky().aggregate(pipeline).into(new ArrayList<>());
        return json(new Document("pipeline", pipeline).append("millis", millisSince(start)).append("groups", groups));
    }

    /** A visitor discovers an object: validated, then inserted with its own shape. */
    @PostMapping("/discoveries")
    ResponseEntity<String> discover(@Validated @RequestBody Discovery discovery) {
        Document doc = discovery.toDocument();
        // Keep the public catalogue tidy: past 40 visitor discoveries, the oldest one fades out.
        long visitors = sky().countDocuments(exists("discovery"));
        if (visitors >= MAX_VISITOR_DISCOVERIES) {
            sky().findOneAndDelete(exists("discovery"),
                    new FindOneAndDeleteOptions().sort(Sorts.ascending("discovery.at")));
        }
        long start = System.nanoTime();
        ObjectId id = sky().insertOne(doc).getInsertedId().asObjectId().getValue(); // the driver adds the _id
        double millis = millisSince(start);
        Document stored = sky().find(eq("_id", id)).first(); // read back exactly as stored
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(json(new Document("document", stored).append("millis", millis)));
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    ResponseEntity<String> invalid(MethodArgumentNotValidException e) {
        Document fields = new Document();
        for (FieldError fieldError : e.getBindingResult().getFieldErrors()) {
            String field = fieldError.getField().replaceAll("\\[\\d+]$", "");
            fields.putIfAbsent(field, fieldError.getDefaultMessage());
        }
        return ResponseEntity.badRequest()
                .contentType(MediaType.APPLICATION_JSON)
                .body(json(new Document("error", "Check the highlighted fields.").append("fields", fields)));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    ResponseEntity<String> unreadable(HttpMessageNotReadableException e) {
        return error(HttpStatus.BAD_REQUEST,
                "Send a JSON body with a type (star, planet, comet or nebula) and that type's fields.");
    }

    private static ResponseEntity<String> error(HttpStatus status, String message) {
        return ResponseEntity.status(status)
                .contentType(MediaType.APPLICATION_JSON)
                .body(json(new Document(Map.of("error", message))));
    }

    private static double millisSince(long startNanos) {
        return Math.round((System.nanoTime() - startNanos) / 10_000.0) / 100.0;
    }

    static String json(Document document) {
        return document.toJson(RELAXED);
    }
}
